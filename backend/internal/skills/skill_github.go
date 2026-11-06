package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/outbound"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	githubAPIBaseURL      = "https://api.github.com"
	githubCodeloadBaseURL = "https://codeload.github.com"
)

func parseGitHubSkillURL(rawURL string, requestedRef string, requestedSubdir string) (githubSkillSpec, error) {
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || target.Scheme != "https" || !strings.EqualFold(target.Hostname(), "github.com") || target.User != nil {
		return githubSkillSpec{}, kernel.BadAuthRequest("请输入公开的 https://github.com 仓库地址")
	}
	parts := strings.Split(strings.Trim(target.Path, "/"), "/")
	if len(parts) < 2 {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 地址必须包含 owner/repository")
	}
	spec := githubSkillSpec{Owner: parts[0], Repo: strings.TrimSuffix(parts[1], ".git"), Ref: strings.TrimSpace(requestedRef), Subdir: strings.Trim(strings.ReplaceAll(strings.TrimSpace(requestedSubdir), "\\", "/"), "/")}
	if len(parts) >= 4 && parts[2] == "tree" {
		if spec.Ref == "" {
			spec.Ref = parts[3]
		}
		if spec.Subdir == "" && len(parts) > 4 {
			spec.Subdir = strings.Join(parts[4:], "/")
		}
	}
	if len(parts) > 2 && parts[2] != "tree" {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 地址必须指向仓库根目录或 tree 子目录")
	}
	if spec.Owner == "" || spec.Repo == "" {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 仓库地址无效")
	}
	return spec, nil
}

func fetchGitHubSkillArchive(ctx context.Context, spec githubSkillSpec) (skillPackageArchive, string, string, string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	apiBase := strings.TrimRight(githubAPIBaseURL, "/")
	resolvedRef := spec.Ref
	if resolvedRef == "" {
		var repoInfo struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := githubJSON(ctx, client, fmt.Sprintf("%s/repos/%s/%s", apiBase, url.PathEscape(spec.Owner), url.PathEscape(spec.Repo)), &repoInfo); err != nil {
			return skillPackageArchive{}, "", "", "", err
		}
		resolvedRef = repoInfo.DefaultBranch
	}
	var commitInfo struct {
		SHA string `json:"sha"`
	}
	if err := githubJSON(ctx, client, fmt.Sprintf("%s/repos/%s/%s/commits/%s", apiBase, url.PathEscape(spec.Owner), url.PathEscape(spec.Repo), url.PathEscape(resolvedRef)), &commitInfo); err != nil {
		if len(resolvedRef) == 40 && outbound.ValidHexDigest(resolvedRef) {
			commitInfo.SHA = strings.ToLower(resolvedRef)
		} else {
			return skillPackageArchive{}, "", "", "", err
		}
	}
	if commitInfo.SHA == "" {
		return skillPackageArchive{}, "", "", "", errors.New("GitHub 未返回提交版本")
	}
	downloadURL := fmt.Sprintf("%s/%s/%s/zip/%s", strings.TrimRight(githubCodeloadBaseURL, "/"), url.PathEscape(spec.Owner), url.PathEscape(spec.Repo), url.PathEscape(commitInfo.SHA))
	candidates := outbound.ExpandGitHubMirrorURLs(downloadURL, "", commitInfo.SHA, "")
	var data []byte
	var lastErr error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		fetched, sizeExceeded, err := downloadAndVerifyGitHubZip(ctx, client, candidate, commitInfo.SHA)
		if sizeExceeded {
			return skillPackageArchive{}, "", "", "", err
		}
		if err != nil {
			lastErr = err
			continue
		}
		data = fetched
		lastErr = nil
		break
	}
	if lastErr != nil {
		return skillPackageArchive{}, "", "", "", lastErr
	}
	archive, err := archiveFromZip(data, spec.Subdir)
	if err != nil {
		return skillPackageArchive{}, "", "", "", err
	}
	canonicalURL := fmt.Sprintf("https://github.com/%s/%s", spec.Owner, spec.Repo)
	return archive, commitInfo.SHA, canonicalURL, resolvedRef, nil
}

func downloadAndVerifyGitHubZip(ctx context.Context, client *http.Client, targetURL, commitSHA string) ([]byte, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: %w", err)
	}
	request.Header.Set("User-Agent", outbound.DefaultOutboundUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxSkillPackageBytes+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > maxSkillPackageBytes {
		return nil, true, kernel.BadAuthRequest("GitHub 技能包超过 200MB")
	}
	if err := verifyGitHubCommitZip(data, commitSHA); err != nil {
		return nil, false, err
	}
	return data, false, nil
}

func verifyGitHubCommitZip(data []byte, expectedCommitSHA string) error {
	want := strings.ToLower(strings.TrimSpace(expectedCommitSHA))
	if len(want) != 40 || !outbound.ValidHexDigest(want) {
		return errors.New("GitHub 未返回有效提交版本")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("下载内容不是有效 ZIP: %w", err)
	}
	if comment := strings.ToLower(strings.TrimSpace(zr.Comment)); comment != "" && comment != want {
		return fmt.Errorf("GitHub 技能包提交校验失败（期望 %s，实际 %s）", want, comment)
	}
	for _, entry := range zr.File {
		prefix, _, ok := strings.Cut(entry.Name, "/")
		if !ok || len(prefix) < 41 {
			continue
		}
		suffix := prefix[len(prefix)-40:]
		if prefix[len(prefix)-41] == '-' && outbound.ValidHexDigest(suffix) {
			if !strings.EqualFold(suffix, want) {
				return fmt.Errorf("GitHub 技能包目录提交校验失败（期望 %s，实际 %s）", want, suffix)
			}
			break
		}
	}
	return nil
}

func githubJSON(ctx context.Context, client *http.Client, target string, output any) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", outbound.DefaultOutboundUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("读取 GitHub 信息失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("读取 GitHub 信息失败: HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}
