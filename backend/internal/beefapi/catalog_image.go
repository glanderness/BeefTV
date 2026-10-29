package beefapi

import "encoding/json"

// Keep the existing capability JSON shape intact. Its server owns model limits;
// validating the shape must not substitute a local model table or size cap.
func NormalizeCatalogImageCapability(raw json.RawMessage) (map[string]any, bool) {
	var value map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || !catalogNumbersFinite(value) {
		return nil, false
	}
	refs, ok := catalogObject(value, "references")
	if !ok {
		return nil, false
	}
	for _, name := range []string{"promptMaxChars", "maxImages", "maxImageBytes"} {
		n, present, valid := catalogIntField(refs, name)
		if !present || !valid || n < 0 {
			return nil, false
		}
	}
	if _, ok := refs["maskSupported"].(bool); !ok {
		return nil, false
	}
	outputs, present, valid := catalogIntField(value, "maxOutputs")
	if !present || !valid || outputs < 1 {
		return nil, false
	}
	if fixed, _, valid := catalogIntField(value, "fixedOutputs"); !valid || fixed < 0 || fixed > outputs {
		return nil, false
	}
	size, ok := catalogObject(value, "size")
	if !ok {
		return nil, false
	}
	parameter, ok := catalogString(size["parameter"])
	if !ok || (parameter != "none" && parameter != "size" && parameter != "aspect_ratio") {
		return nil, false
	}
	sizes, ok := catalogStringList(size["values"], true)
	if size["values"] == nil && parameter == "none" {
		sizes = []string{}
		size["values"] = sizes
		ok = true
	}
	if !ok {
		return nil, false
	}
	allowCustom, ok := size["allowCustom"].(bool)
	if !ok {
		return nil, false
	}
	defaultSize, ok := catalogString(size["default"])
	if !ok || (parameter != "none" && (defaultSize == "" || (!allowCustom && !containsCatalogString(sizes, defaultSize)))) {
		return nil, false
	}
	quality, ok := catalogObject(value, "quality")
	if !ok {
		return nil, false
	}
	qualitySupported, ok := quality["supported"].(bool)
	if !ok {
		return nil, false
	}
	qualities, ok := catalogStringList(quality["values"], true)
	if quality["values"] == nil && !qualitySupported {
		qualities = []string{}
		quality["values"] = qualities
		ok = true
	}
	if !ok {
		return nil, false
	}
	defaultQuality, ok := catalogString(quality["default"])
	if !ok || (qualitySupported && !containsCatalogString(qualities, defaultQuality)) {
		return nil, false
	}
	for _, name := range []string{"transparentBackground", "responseFormat", "outputFormat"} {
		item, ok := catalogObject(value, name)
		if !ok {
			return nil, false
		}
		if _, ok := item["supported"].(bool); !ok {
			return nil, false
		}
	}
	return value, true
}
