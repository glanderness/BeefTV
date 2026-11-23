package assets

import "strings"

const (
	resourceStoragePrefix = "resource:"
	resourceFileURLPrefix = "/api/resources/"
)

func FileURL(id string) string {
	return resourceFileURLPrefix + id + "/file"
}

func IsFileURL(value string) bool {
	return IDFromFileURL(value) != ""
}

func IDFromFileURL(value string) string {
	value = strings.TrimSpace(value)
	index := strings.Index(value, resourceFileURLPrefix)
	if index < 0 {
		return ""
	}
	remainder := value[index+len(resourceFileURLPrefix):]
	if remainder == "" {
		return ""
	}
	if end := strings.IndexAny(remainder, "/?#"); end >= 0 {
		remainder = remainder[:end]
	}
	return remainder
}

func ResourceID(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, resourceStoragePrefix) {
		return ValidID(strings.TrimPrefix(value, resourceStoragePrefix))
	}
	return ValidID(IDFromFileURL(value))
}

func ValidID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 80 {
		return ""
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return ""
		}
	}
	return value
}
