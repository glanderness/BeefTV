package assets

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

// Single canonical syntax table for resource references inside JSON/raw
// documents. Semantic walking, in-memory prefiltering, and repository SQL
// filters all derive from these definitions.
var (
	referenceLocatorPrefixes = []string{resourceStoragePrefix, resourceFileURLPrefix}
	bareResourceIDFields     = []string{"resourceId", "resourceIds", "sampleResourceId", "referenceResourceId", "referenceResourceIds"}
	bareResourceIDKeyTokens  = []string{"resourceId", "ResourceId"}
	referenceEscapeMarkers   = []string{`\u`, `\/`}
)

// ReferencePrefilterTokens returns the canonical substring set that any
// document containing a resource reference must match.
func ReferencePrefilterTokens() []string {
	tokens := make([]string, 0, len(referenceLocatorPrefixes)+len(bareResourceIDKeyTokens)+len(referenceEscapeMarkers))
	tokens = append(tokens, referenceLocatorPrefixes...)
	tokens = append(tokens, bareResourceIDKeyTokens...)
	tokens = append(tokens, referenceEscapeMarkers...)
	return tokens
}

func DocumentReferences(raw string, resourceIDs map[string]struct{}) bool {
	return len(DocumentReferencedIDs(raw, resourceIDs)) > 0
}

func DocumentReferencedIDs(raw string, resourceIDs map[string]struct{}) map[string]struct{} {
	matched := map[string]struct{}{}
	raw = strings.TrimSpace(raw)
	if raw == "" || len(resourceIDs) == 0 {
		return matched
	}
	if !mayReferenceAnyResourceID(raw, resourceIDs) {
		return matched
	}
	return documentReferencedIDsExact(raw, resourceIDs)
}

func documentReferencedIDsExact(raw string, resourceIDs map[string]struct{}) map[string]struct{} {
	matched := map[string]struct{}{}
	found := map[string]struct{}{}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err == nil {
		if scalar, ok := value.(string); ok {
			if resourceID := ResourceID(scalar); resourceID != "" {
				found[resourceID] = struct{}{}
			}
		} else {
			walkReferenceDocument(value, "", found)
		}
	} else if resourceID := ResourceID(raw); resourceID != "" {
		found[resourceID] = struct{}{}
	}
	for resourceID := range found {
		if _, exists := resourceIDs[resourceID]; exists {
			matched[resourceID] = struct{}{}
		}
	}
	return matched
}

func CollectOwnedDocumentReferences(raw string, resourceIDs map[string]struct{}) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return err
	}
	collectDecodedDocumentReferences(value, resourceIDs)
	return nil
}

// CollectOwnedDocumentReferencesFromDecoded reuses a decoded JSON document.
// Scientific notation and very long numbers retain the original parser's range
// checks, including values overwritten by duplicate keys during decoding.
func CollectOwnedDocumentReferencesFromDecoded(raw string, value any, resourceIDs map[string]struct{}) error {
	if referenceNumbersNeedValidation(raw) {
		return CollectOwnedDocumentReferences(raw, resourceIDs)
	}
	collectDecodedDocumentReferences(value, resourceIDs)
	return nil
}

func collectDecodedDocumentReferences(value any, resourceIDs map[string]struct{}) {
	if scalar, ok := value.(string); ok {
		if resourceID := ResourceID(scalar); resourceID != "" {
			resourceIDs[resourceID] = struct{}{}
		}
		return
	}
	walkReferenceDocument(value, "", resourceIDs)
}

// raw is already validated JSON. Skip strings (including escaped quotes) so
// resource IDs and prompts containing exponent-like text stay on the fast path.
func referenceNumbersNeedValidation(raw string) bool {
	digits := 0
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			digits = 0
			for i++; i < len(raw); i++ {
				if raw[i] == '\\' {
					i++
				} else if raw[i] == '"' {
					break
				}
			}
		} else if raw[i] >= '0' && raw[i] <= '9' {
			digits++
			if digits >= 309 || (i+1 < len(raw) && (raw[i+1] == 'e' || raw[i+1] == 'E')) {
				return true
			}
		} else {
			digits = 0
		}
	}
	return false
}

func SortedIDs(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func walkReferenceDocument(value any, parentKey string, resourceIDs map[string]struct{}) {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			walkReferenceDocument(child, key, resourceIDs)
		}
	case []any:
		for _, child := range item {
			walkReferenceDocument(child, parentKey, resourceIDs)
		}
	case string:
		if isResourceLocatorField(parentKey) {
			if resourceID := ResourceID(item); resourceID != "" {
				resourceIDs[resourceID] = struct{}{}
			}
		}
		if isBareResourceIDField(parentKey) {
			if resourceID := ValidID(item); resourceID != "" {
				resourceIDs[resourceID] = struct{}{}
			}
		}
	}
}

func isBareResourceIDField(field string) bool {
	return slices.Contains(bareResourceIDFields, field)
}

func isResourceLocatorField(field string) bool {
	switch field {
	case "storageKey", "content", "previewContent", "drawingPreviewStorageKey", "drawingPreviewUrl", "url", "dataUrl", "coverUrl", "imageUrl", "videoUrl", "audioUrl", "referenceUrl", "referenceUrls", "artifactRef", "providerArtifactRef":
		return true
	default:
		return false
	}
}

// mayReferenceAnyResourceID is a zero-allocation conservative prefilter for
// DocumentReferencedIDs derived from the canonical syntax tables above.
// Returning false guarantees documentReferencedIDsExact would find no match;
// returning true falls through to exact JSON parsing.
func mayReferenceAnyResourceID(raw string, resourceIDs map[string]struct{}) bool {
	for _, marker := range referenceEscapeMarkers {
		if strings.Contains(raw, marker) {
			return true
		}
	}
	for _, prefix := range referenceLocatorPrefixes {
		if scanLocatorCandidates(raw, prefix, resourceIDs) {
			return true
		}
	}
	for _, keyToken := range bareResourceIDKeyTokens {
		if scanBareIDKeyCandidates(raw, keyToken, resourceIDs) {
			return true
		}
	}
	return false
}

func isValidIDByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_'
}

func scanLocatorCandidates(raw, prefix string, resourceIDs map[string]struct{}) bool {
	for offset := 0; offset < len(raw); {
		index := strings.Index(raw[offset:], prefix)
		if index < 0 {
			return false
		}
		start := offset + index + len(prefix)
		if start >= len(raw) {
			return false
		}
		first := raw[start]
		if first == '\\' || first <= ' ' || first >= 0x80 {
			return true
		}
		end := start
		for end < len(raw) && end-start < 80 && isValidIDByte(raw[end]) {
			end++
		}
		if end > start {
			if _, exists := resourceIDs[raw[start:end]]; exists {
				return true
			}
		}
		offset = start
	}
	return false
}

func scanBareIDKeyCandidates(raw, keySuffix string, resourceIDs map[string]struct{}) bool {
	for offset := 0; offset < len(raw); {
		index := strings.Index(raw[offset:], keySuffix)
		if index < 0 {
			return false
		}
		p := offset + index + len(keySuffix)
		offset = p
		if p < len(raw) && raw[p] == 's' {
			p++
		}
		if p >= len(raw) || raw[p] != '"' {
			continue
		}
		p = skipJSONWhitespace(raw, p+1)
		if p >= len(raw) || raw[p] != ':' {
			continue
		}
		p = skipJSONWhitespace(raw, p+1)
		if p >= len(raw) {
			return true
		}
		switch raw[p] {
		case '"':
			matched, conservative, _ := scanJSONStringCandidate(raw, p, resourceIDs)
			if matched || conservative {
				return true
			}
		case '[':
			if scanJSONArrayCandidates(raw, p, resourceIDs) {
				return true
			}
		}
	}
	return false
}

func scanJSONStringCandidate(raw string, quotePos int, resourceIDs map[string]struct{}) (matched bool, conservative bool, nextPos int) {
	start := quotePos + 1
	for i := start; i < len(raw); i++ {
		b := raw[i]
		if b == '\\' {
			return false, true, i
		}
		if b == '"' {
			trimmed := strings.TrimSpace(raw[start:i])
			if trimmed != "" {
				if _, exists := resourceIDs[trimmed]; exists {
					return true, false, i + 1
				}
			}
			return false, false, i + 1
		}
	}
	return false, true, len(raw)
}

func scanJSONArrayCandidates(raw string, openPos int, resourceIDs map[string]struct{}) bool {
	depth := 0
	for i := openPos; i < len(raw); i++ {
		switch raw[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return false
			}
		case '"':
			matched, conservative, nextPos := scanJSONStringCandidate(raw, i, resourceIDs)
			if matched || conservative {
				return true
			}
			i = nextPos - 1
		case '{':
			return true
		}
	}
	return true
}

func skipJSONWhitespace(raw string, p int) int {
	for p < len(raw) {
		switch raw[p] {
		case ' ', '\t', '\n', '\r':
			p++
		default:
			return p
		}
	}
	return p
}
