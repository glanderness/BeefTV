package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

func buildZIP(brandName string, bundleID string, manifest manifest, collection *collection) ([]byte, error) {
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipFile(archive, "manifest.json", append(manifestData, byte(10))); err != nil {
		return nil, err
	}
	newline := string(rune(10))
	readme := fmt.Sprintf("%s 用户诊断包%s%s诊断编号：%s%s时间范围：%s 至 %s%s%s该文件由用户主动导出，仅包含有限时间范围内的脱敏诊断摘要。%s", brandName, newline, newline, bundleID, newline, collection.Window.From.Format(time.RFC3339), collection.Window.To.Format(time.RFC3339), newline, newline, newline)
	if err := writeZipFile(archive, "README.txt", []byte(readme)); err != nil {
		return nil, err
	}
	if err := writeJSONL(archive, "client/events.jsonl", collection.ClientEvents); err != nil {
		return nil, err
	}
	if err := writeJSONL(archive, "backend/tasks.jsonl", collection.Tasks); err != nil {
		return nil, err
	}
	if err := writeJSONL(archive, "backend/task-logs.jsonl", collection.TaskLogs); err != nil {
		return nil, err
	}
	if err := writeJSONL(archive, "backend/upstream-calls.jsonl", collection.APICalls); err != nil {
		return nil, err
	}
	runtimeData, err := json.MarshalIndent(collection.Runtime, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeZipFile(archive, "context/runtime.json", append(runtimeData, byte(10))); err != nil {
		return nil, err
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func writeJSONL[T any](archive *zip.Writer, name string, records []T) error {
	var data bytes.Buffer
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		data.Write(encoded)
		data.WriteByte(10)
	}
	return writeZipFile(archive, name, data.Bytes())
}

func writeZipFile(archive *zip.Writer, name string, data []byte) error {
	file, err := archive.Create(name)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	return err
}
