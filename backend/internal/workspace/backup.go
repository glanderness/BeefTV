package workspace

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Backup and Restore are unused by production desktop/HTTP/CLI paths.
// Product ZIP import/export lives on the editing surface
// (web/src/lib/canvas/canvas-export.ts, web/src/pages/assets/asset-transfer.ts).
// These helpers are kept only as a future workspace tar.gz seam.

func Backup(sourceDir, archivePath string) error {
	if strings.TrimSpace(sourceDir) == "" || strings.TrimSpace(archivePath) == "" {
		return errors.New("备份来源和目标不能为空")
	}
	sourceAbs, err := filepath.Abs(sourceDir)
	if err != nil {
		return err
	}
	archiveAbs, err := filepath.Abs(archivePath)
	if err != nil {
		return err
	}
	inside, err := pathIsInside(archiveAbs, sourceAbs)
	if err != nil {
		return err
	}
	if inside {
		return errors.New("备份目标不能位于来源目录内")
	}
	if err := os.MkdirAll(filepath.Dir(archiveAbs), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(archiveAbs), ".workspace-backup-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	gzipWriter := gzip.NewWriter(tmp)
	tarWriter := tar.NewWriter(gzipWriter)
	walkErr := filepath.Walk(sourceAbs, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		mode := info.Mode()
		if mode&os.ModeSymlink != 0 {
			return fmt.Errorf("备份不允许符号链接: %s", path)
		}
		if !mode.IsDir() && !mode.IsRegular() {
			return fmt.Errorf("备份不允许特殊文件: %s", path)
		}
		relative, err := filepath.Rel(sourceAbs, path)
		if err != nil || relative == "." {
			return err
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(tarWriter, file)
		closeErr := file.Close()
		return errors.Join(copyErr, closeErr)
	})
	closeErr := errors.Join(tarWriter.Close(), gzipWriter.Close(), tmp.Sync(), tmp.Close())
	if err := errors.Join(walkErr, closeErr); err != nil {
		return err
	}
	if err := verifyGzipChecksum(tmpPath); err != nil {
		return err
	}
	return os.Rename(tmpPath, archiveAbs)
}

func Restore(archivePath, targetDir string) error {
	if _, err := os.Lstat(targetDir); err == nil {
		return errors.New("恢复目标已存在，拒绝覆盖")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(targetDir)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp(parent, ".workspace-restore-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	archive, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		clean, err := confinedArchivePath(header.Name)
		if err != nil {
			return err
		}
		path := filepath.Join(tmpDir, clean)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return err
			}
			file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(file, reader)
			closeErr := file.Close()
			if err := errors.Join(copyErr, closeErr); err != nil {
				return err
			}
		default:
			return errors.New("备份包含不支持的文件类型")
		}
	}
	if _, err := io.Copy(io.Discard, gzipReader); err != nil {
		return fmt.Errorf("备份校验失败: %w", err)
	}
	return publishRestoredWorkspace(tmpDir, targetDir)
}

func publishRestoredWorkspace(tmpDir, targetDir string) error {
	if err := restoreBeforePublish(targetDir); err != nil {
		return err
	}
	if _, err := os.Lstat(targetDir); err == nil {
		return errors.New("恢复目标已存在，拒绝覆盖")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tmpDir, targetDir); err != nil {
		if _, existsErr := os.Lstat(targetDir); existsErr == nil {
			return errors.New("恢复目标已存在，拒绝覆盖")
		}
		return err
	}
	return nil
}

var restoreBeforePublish = func(string) error { return nil }

func confinedArchivePath(name string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || clean == ".." || filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("备份包含越界路径")
	}
	return clean, nil
}

func pathIsInside(inner, outer string) (bool, error) {
	rel, err := filepath.Rel(outer, inner)
	if err != nil {
		return false, err
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)), nil
}

func verifyGzipChecksum(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer reader.Close()
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return fmt.Errorf("备份校验失败: %w", err)
	}
	return nil
}
