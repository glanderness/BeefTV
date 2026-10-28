#!/usr/bin/env python3
"""Sync new or updated GitHub issues of glanderness/BeefTV into the Feishu requirement table.

Read-only by default: it pulls the GitHub issues and the Feishu table, then prints a
plan (create / append / skip). Pass --apply to write the plan through lark-cli and
re-read the table afterwards.

Procedure, field mapping and dedup rules: docs/research/github-issue-sync-to-requirement-table.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = "glanderness/BeefTV"
BASE_TOKEN = "OcHnbZCXjaMwwrsx4laciEvRnHo"
TABLE_ID = "tblvTTmtzdPF6qxx"

# Field ids of 需求表 tblvTTmtzdPF6qxx (lark-cli base +field-list).
FIELD_REQUIREMENT = "fldsisKbk9"
FIELD_ERROR_LOG = "fldijvUPne"
FIELD_PROGRESS = "fld75zOrkE"
FIELD_STATUS = "fldGSVHgeh"
FIELD_ATTACHMENT = "fldzeoKcZ8"

STATUS_IN_PROGRESS = "正在处理"
ISSUE_MARKER = re.compile(r"GitHub Issue #(\d+)")
DEFAULT_STATE_PATH = Path.home() / ".local/state/beeftv/github-issue-sync.json"
DEFAULT_LOOKBACK = dt.timedelta(hours=48)

MAINTAINER_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
TITLE_PREFIX = re.compile(r"^\s*\[(bug|feature|feature request|enhancement|question|docs)\]\s*", re.I)
VERSION_RE = re.compile(r"\bv?(\d+\.\d+\.\d+)\b")
# Maintainer replies often arrive by mail, so the body carries the whole quoted thread.
QUOTE_START = re.compile(r"^\s*>|写道[:：]\s*$|wrote:\s*$")
MAIL_FOOTER = re.compile(r"Reply to this email directly|You are receiving this because|Message ID:|unsubscribe|\*@\*\*\*\.\*\*\*")
PLATFORM_PATTERNS = (
    ("Windows", re.compile(r"windows", re.I)),
    ("macOS", re.compile(r"mac\s?os|macos|darwin", re.I)),
    ("Ubuntu", re.compile(r"ubuntu", re.I)),
    ("Linux", re.compile(r"linux", re.I)),
)


class SyncError(RuntimeError):
    pass


def _run(args, cwd=None):
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SyncError(f"{' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip()[:800]}")
    return proc.stdout


def parse_ts(value):
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def iso_now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def today_str(now=None):
    return (now or iso_now()).astimezone(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d")


def strip_quoted(text):
    """Drop quoted threads and mail footers that GitHub keeps in e-mail replies."""
    kept = []
    for line in (text or "").splitlines():
        if QUOTE_START.search(line) or MAIL_FOOTER.search(line):
            break
        kept.append(line)
    return "\n".join(kept).strip()


def collapse(text, limit=None, note="…（原文与附件见 issue）"):
    text = re.sub(r"\s+", " ", strip_quoted(text))
    if limit and len(text) > limit:
        return text[: limit - len(note)].rstrip() + note
    return text


def truncate(text, limit):
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def first_sentence(text, limit=40):
    for chunk in re.split(r"[。！？!?\n]", collapse(text)):
        chunk = chunk.strip(" -—:：,，")
        if chunk:
            return truncate(chunk, limit)
    return ""


def detect_meta(body):
    """Version / platform hint for the marker line, e.g. "v2.0.2 / Windows"."""
    body = body or ""
    version = VERSION_RE.search(body)
    platform = next((name for name, pattern in PLATFORM_PATTERNS if pattern.search(body)), None)
    return " / ".join(part for part in (f"v{version.group(1)}" if version else None, platform) if part)


def requirement_title(issue):
    title = TITLE_PREFIX.sub("", issue.get("title") or "").strip()
    if not title or set(title) <= set("[]() BugFeature"):
        title = first_sentence(issue.get("body") or "")
    return truncate(title, 40) or f"GitHub Issue #{issue['number']}"


def maintainer_comments(issue):
    out = []
    for comment in issue.get("comments") or []:
        if (comment.get("authorAssociation") or "").upper() not in MAINTAINER_ASSOCIATIONS:
            continue
        out.append((comment.get("createdAt", "")[:10], collapse(comment.get("body"), 200)))
    return out


def issue_record_index(rows):
    """record_id per GitHub issue number, from the 来源：GitHub Issue #N marker."""
    index = {}
    for row in rows:
        for name in ("报错日志", "进度说明"):
            for match in ISSUE_MARKER.finditer(row.get(name) or ""):
                index.setdefault(int(match.group(1)), row["record_id"])
    return index


def join_text(old, addition):
    old = (old or "").strip()
    return f"{old}\n\n{addition}" if old else addition


def new_row_fields(issue, today):
    number = issue["number"]
    meta = detect_meta(issue.get("body")) or "未标注版本/平台"
    log = (
        f"来源：GitHub Issue #{number}（{issue['url']}，@{issue['author']['login']}，"
        f"{issue.get('createdAt', '')[:10]}，{meta}）："
        f"{collapse(issue.get('body'), 800) or '（无正文）'}"
    )
    for date, body in maintainer_comments(issue):
        log += f" 维护者 {date} 回复：{body}"
    progress = (
        f"{today} 登记（来源：GitHub Issue #{number}）：新登记的 GitHub issue，"
        f"当前 {issue['state'].lower()}，共 {len(issue.get('comments') or [])} 条评论；处理结论待补充。"
    )
    return {
        FIELD_REQUIREMENT: requirement_title(issue),
        FIELD_ERROR_LOG: log,
        FIELD_PROGRESS: progress,
        FIELD_STATUS: [STATUS_IN_PROGRESS],
    }


def updated_fields(issue, row, since, today):
    """Append the comments newer than `since`; returns None when nothing is new."""
    fresh = [c for c in issue.get("comments") or [] if parse_ts(c["createdAt"]) > since]
    if not fresh:
        return None
    number = issue["number"]
    items = "；".join(
        f"@{c['author']['login'] if c.get('author') else 'unknown'} {c['createdAt'][:10]}：{collapse(c.get('body'), 300)}"
        for c in fresh
    )
    old_log = row.get("报错日志") or ""
    counter = len(re.findall(r"(?m)^\s*\d+\.", old_log)) + 1
    log_add = f"{counter}. GitHub Issue #{number} 新评论（{today}）：{items}"
    if issue["state"].upper() != "OPEN":
        log_add += f"（issue 现已 {issue['state'].lower()}）"
    progress_add = (
        f"{today} 同步 GitHub Issue #{number} 新评论（并入本行）：新增 {len(fresh)} 条评论，"
        f"已追加到报错日志；本行状态与负责人未改。"
    )
    return {
        FIELD_ERROR_LOG: join_text(old_log, log_add),
        FIELD_PROGRESS: join_text(row.get("进度说明") or "", progress_add),
    }


def bigrams(text):
    text = re.sub(r"\s+", "", text or "")
    return {text[i : i + 2] for i in range(len(text) - 1)}


def near_duplicates(issue, rows, threshold=0.25, limit=3):
    """L3 hint only: rows whose 需求内容 overlaps the new issue, for human confirmation."""
    target = bigrams((issue.get("title") or "") + collapse(issue.get("body"), 200))
    scored = []
    for row in rows:
        candidate = bigrams(row.get("需求内容") or "")
        if not target or not candidate:
            continue
        score = len(target & candidate) / len(target | candidate)
        if score >= threshold:
            scored.append((round(score, 3), row["record_id"], row.get("需求内容") or ""))
    return sorted(scored, reverse=True)[:limit]


def build_plan(issues, rows, since, today):
    index = issue_record_index(rows)
    by_id = {row["record_id"]: row for row in rows}
    plan = {
        "generated_at": iso_now().isoformat(),
        "since": since.isoformat(),
        "create_records": [],
        "update_records": {},
        "notes": [],
        "near_duplicates": [],
    }
    for issue in sorted(issues, key=lambda i: i["number"]):
        number = issue["number"]
        if number in index:
            fields = updated_fields(issue, by_id.get(index[number], {}), since, today)
            if fields:
                plan["update_records"][index[number]] = fields
            else:
                plan["notes"].append(f"#{number} 已登记，无新评论（update {issue.get('updatedAt', '')[:10]}）")
            continue
        if issue["state"].upper() != "OPEN":
            plan["notes"].append(f"#{number} 已关闭且表内无对应行，按规则不自动补登")
            continue
        plan["create_records"].append(new_row_fields(issue, today))
        for score, record_id, requirement in near_duplicates(issue, rows):
            plan["near_duplicates"].append(
                f"#{number} 疑似与 {record_id}「{truncate(requirement, 30)}」重复（相似度 {score}），需人工确认"
            )
    return plan


def describe_plan(plan):
    lines = [f"同步游标：{plan['since']}"]
    for record in plan["create_records"]:
        lines.append(f"新建：{record[FIELD_REQUIREMENT]}  ←  {ISSUE_MARKER.search(record[FIELD_ERROR_LOG]).group(0)}")
    for record_id, fields in plan["update_records"].items():
        marker = ISSUE_MARKER.search(fields[FIELD_ERROR_LOG])
        lines.append(f"并入：{record_id}  ←  {marker.group(0) if marker else '(未识别)'}")
    lines += [f"跳过：{note}" for note in plan["notes"]]
    lines += [f"待人工确认：{note}" for note in plan["near_duplicates"]]
    lines.append(
        f"合计：新建 {len(plan['create_records'])} 行、并入 {len(plan['update_records'])} 行、跳过 {len(plan['notes'])} 条"
    )
    return "\n".join(lines)


def fetch_issues(runner=_run):
    out = runner(
        [
            "gh", "issue", "list", "--repo", REPO, "--state", "all", "--limit", "500",
            "--json", "number,title,state,url,createdAt,updatedAt,author,labels,body,comments",
        ]
    )
    return json.loads(out)


def fetch_rows(runner=_run, workdir=None):
    workdir = Path(workdir or tempfile.mkdtemp(prefix="beeftv-issue-sync-"))
    runner(
        [
            "lark-cli", "base", "+record-list", "--base-token", BASE_TOKEN, "--table-id", TABLE_ID,
            "--format", "ndjson", "--output", "table.ndjson", "--overwrite", "--as", "user",
        ],
        cwd=workdir,
    )
    text = (workdir / "table.ndjson").read_text()
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def extract_record_ids(payload_text):
    ids = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "record_id" and isinstance(value, str):
                    ids.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(json.loads(payload_text))
    return ids


def apply_plan(runner, plan, workdir):
    workdir = Path(workdir)
    created = []
    if plan["create_records"]:
        (workdir / "create.json").write_text(json.dumps({"create_records": plan["create_records"]}, ensure_ascii=False))
        out = runner(
            ["lark-cli", "base", "+record-batch-create", "--base-token", BASE_TOKEN, "--table-id", TABLE_ID,
             "--as", "user", "--json", "@create.json"],
            cwd=workdir,
        )
        created = extract_record_ids(out)
    if plan["update_records"]:
        (workdir / "update.json").write_text(json.dumps({"update_records": plan["update_records"]}, ensure_ascii=False))
        runner(
            ["lark-cli", "base", "+record-batch-update", "--base-token", BASE_TOKEN, "--table-id", TABLE_ID,
             "--as", "user", "--json", "@update.json"],
            cwd=workdir,
        )
    return created


def verify_plan(runner, plan, workdir, attempts=3, pause=3.0):
    """Read the table back; Feishu can serve a stale snapshot right after a write."""
    problems = []
    for attempt in range(attempts):
        problems = check_rows(fetch_rows(runner, workdir), plan)
        if not problems:
            break
        if attempt + 1 < attempts:
            time.sleep(pause)
    return problems


def check_rows(rows, plan):
    by_id = {row["record_id"]: row for row in rows}
    problems = []
    for record in plan["create_records"]:
        number = ISSUE_MARKER.search(record[FIELD_ERROR_LOG]).group(1)
        hit = next(
            (rid for rid, row in by_id.items() if f"GitHub Issue #{number}（" in (row.get("报错日志") or "")),
            None,
        )
        if hit:
            print(f"核对通过：新建 #{number} -> {hit}")
        else:
            problems.append(f"新建 #{number} 在表内找不到 来源标记")
    for record_id, fields in plan["update_records"].items():
        row = by_id.get(record_id)
        if row is None:
            problems.append(f"并入 {record_id} 行不存在")
            continue
        for field_id, name in ((FIELD_ERROR_LOG, "报错日志"), (FIELD_PROGRESS, "进度说明")):
            tail = (fields[field_id] or "").split("\n\n")[-1]
            if tail and tail not in (row.get(name) or ""):
                problems.append(f"并入 {record_id} 的{name}未读到新段落")
                break
        else:
            print(f"核对通过：并入 {record_id}")
    return problems


def load_state(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def save_state(path, since, issues, index, now):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "lastSyncAt": now.isoformat(),
                "previousSyncAt": since.isoformat(),
                "issues": {
                    str(issue["number"]): {
                        "state": issue["state"],
                        "updatedAt": issue["updatedAt"],
                        "comments": len(issue.get("comments") or []),
                        "recordId": index.get(issue["number"]),
                    }
                    for issue in issues
                },
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )


def resolve_since(args, state, now):
    if args.since:
        return parse_ts(args.since)
    if state.get("lastSyncAt"):
        return parse_ts(state["lastSyncAt"])
    return now - DEFAULT_LOOKBACK


def main(argv=None, runner=_run):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", help="同步游标（ISO8601）；默认取 state 文件，其次回看 48 小时")
    parser.add_argument("--state", default=str(DEFAULT_STATE_PATH), help="游标文件路径")
    parser.add_argument("--workdir", help="临时工作目录（默认新建临时目录）")
    parser.add_argument("--plan-out", help="把计划写到文件，供人工改词后 --apply-plan")
    parser.add_argument("--apply-plan", help="应用给定的计划文件（可人工改过）")
    parser.add_argument("--apply", action="store_true", help="计算计划并立即写表")
    parser.add_argument("--no-verify", action="store_true", help="写表后不读回核对")
    args = parser.parse_args(argv)

    workdir = Path(args.workdir or tempfile.mkdtemp(prefix="beeftv-issue-sync-"))
    workdir.mkdir(parents=True, exist_ok=True)
    state = load_state(args.state)
    now = iso_now()

    if args.apply_plan:
        plan = json.loads(Path(args.apply_plan).read_text())
    else:
        since = resolve_since(args, state, now)
        plan = build_plan(fetch_issues(runner), fetch_rows(runner, workdir), since, today_str(now))
        print(describe_plan(plan))
        if args.plan_out:
            Path(args.plan_out).write_text(json.dumps(plan, ensure_ascii=False, indent=2))
            print(f"计划已写入 {args.plan_out}")

    if not args.apply and not args.apply_plan:
        print("（只读模式，未写表；加 --apply 才会写入）")
        return 0
    if args.apply_plan and not args.apply:
        print("（已读入计划文件；加 --apply 才会写入）")
        return 0

    created = apply_plan(runner, plan, workdir)
    problems = [] if args.no_verify else verify_plan(runner, plan, workdir)
    index = issue_record_index(fetch_rows(runner, workdir))
    save_state(args.state, parse_ts(plan["since"]), fetch_issues(runner), index, iso_now())
    print(f"写表完成：新建 {len(created)} 行、并入 {len(plan['update_records'])} 行")
    if problems:
        print("核对发现问题：\n  " + "\n  ".join(problems))
        return 1
    print("逐条读回核对通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
