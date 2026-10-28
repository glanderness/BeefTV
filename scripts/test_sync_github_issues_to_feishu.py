"""No network, no writes: fake gh / lark-cli runners over an in-memory table."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sync_github_issues_to_feishu", Path(__file__).with_name("sync-github-issues-to-feishu.py")
)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

LOG = "报错日志"
PROGRESS = "进度说明"
REQUIREMENT = "需求内容"

# The real table returns field names in ndjson but accepts field ids on write.
FIELD_NAMES = {
    sync.FIELD_REQUIREMENT: REQUIREMENT,
    sync.FIELD_ERROR_LOG: LOG,
    sync.FIELD_PROGRESS: PROGRESS,
    sync.FIELD_STATUS: "目前状况",
    sync.FIELD_ATTACHMENT: "对应截图",
}


def issue(number, **overrides):
    base = {
        "number": number,
        "title": f"[Bug] 问题 {number}",
        "state": "OPEN",
        "url": f"https://github.com/glanderness/BeefTV/issues/{number}",
        "createdAt": "2026-10-20T02:00:00Z",
        "updatedAt": "2026-10-20T02:00:00Z",
        "author": {"login": "reporter"},
        "labels": [],
        "body": "复现步骤：点一下就崩。v2.0.2 / Windows 11。",
        "comments": [],
    }
    base.update(overrides)
    return base


def comment(login, body, created="2026-10-27T03:26:00Z", association="NONE"):
    return {"author": {"login": login}, "body": body, "createdAt": created, "authorAssociation": association}


def row(record_id, requirement, log="", progress=""):
    return {"record_id": record_id, REQUIREMENT: requirement, LOG: log, PROGRESS: progress}


class FakeFeishu:
    def __init__(self, rows, issues):
        self.rows = [dict(r) for r in rows]
        self.issues = issues
        self.commands = []

    def runner(self, args, cwd=None):
        self.commands.append(list(args))
        if args[0] == "gh":
            return json.dumps(self.issues)
        action = args[2]
        if action == "+record-list":
            Path(cwd, "table.ndjson").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in self.rows))
            return "{}"
        if action == "+record-batch-create":
            payload = json.loads(Path(cwd, args[-1].lstrip("@")).read_text())
            created = []
            for index, fields in enumerate(payload["create_records"]):
                record_id = f"recNEW{index}"
                self.rows.append({"record_id": record_id, **self._named(fields)})
                created.append({"record_id": record_id})
            return json.dumps({"data": {"records": created}})
        if action == "+record-batch-update":
            payload = json.loads(Path(cwd, args[-1].lstrip("@")).read_text())
            for record_id, fields in payload["update_records"].items():
                for existing in self.rows:
                    if existing["record_id"] == record_id:
                        existing.update(self._named(fields))
            return json.dumps({"data": {}})
        raise AssertionError(f"unexpected command: {args}")

    @staticmethod
    def _named(fields):
        return {FIELD_NAMES.get(key, key): value for key, value in fields.items()}


class PlanTests(unittest.TestCase):
    def test_marker_index_reads_both_fields(self):
        rows = [
            row("recA", "模型渠道无法删除", log="1. 来源：GitHub Issue #122（https://x/122）：…"),
            row("recB", "画布卡顿", progress="2026-10-27 同步 GitHub Issue #21（并入本行）：…"),
            row("recC", "没有来源"),
        ]
        self.assertEqual(sync.issue_record_index(rows), {122: "recA", 21: "recB"})

    def test_requirement_title_falls_back_to_body_when_title_is_only_a_tag(self):
        self.assertEqual(sync.requirement_title(issue(118, title="[Bug]", body="15 张图片批量生成大量失败。")), "15 张图片批量生成大量失败")
        self.assertEqual(sync.requirement_title(issue(19, title="[Feature] 如果能增加本地 ComfyUI 支持就更好了")), "如果能增加本地 ComfyUI 支持就更好了")

    def test_detect_meta_reads_version_and_platform(self):
        self.assertEqual(sync.detect_meta("复现于 v1.7.15 / Windows 10 x64"), "v1.7.15 / Windows")
        self.assertEqual(sync.detect_meta("没有版本信息"), "")

    def test_collapse_drops_mailed_quotes_and_footers(self):
        body = (
            "放进后续的插件里面 这周会上 token在燃烧了！\n\n"
            "chuansen ***@***.***> 于2026年10月27日周二 11:26写道：\n\n"
            "> *chuansenwang* left a comment (glanderness/BeefTV#19)\n"
            "> Reply to this email directly, view it on GitHub\n"
        )
        self.assertEqual(sync.collapse(body), "放进后续的插件里面 这周会上 token在燃烧了！")

    def test_new_row_carries_marker_status_and_maintainer_reply(self):
        fields = sync.new_row_fields(
            issue(
                98,
                title="[Feature] 能否增加删除助手的聊天记录",
                comments=[comment("enderzcx", "已记录为功能需求，保留。", association="COLLABORATOR")],
            ),
            "2026-10-28",
        )
        self.assertEqual(fields[sync.FIELD_STATUS], [sync.STATUS_IN_PROGRESS])
        self.assertIn("来源：GitHub Issue #98（https://github.com/glanderness/BeefTV/issues/98，@reporter，2026-10-20，v2.0.2 / Windows）", fields[sync.FIELD_ERROR_LOG])
        self.assertIn("维护者 2026-10-27 回复：已记录为功能需求，保留。", fields[sync.FIELD_ERROR_LOG])
        self.assertIn("2026-10-28 登记（来源：GitHub Issue #98）", fields[sync.FIELD_PROGRESS])

    def test_updated_fields_appends_only_new_comments(self):
        existing = row(
            "recA",
            "支持接入 ComfyUI",
            log="1. 群友反馈。\n2. 历史反馈。\n3. GitHub Issue #19（https://x/19）：初始登记。",
            progress="2026-10-27 同步 GitHub Issue #19（并入本行）：仓库侧状态未变。",
        )
        fields = sync.updated_fields(
            issue(19, updatedAt="2026-10-27T03:26:00Z", comments=[comment("chuansenwang", "什么时候可以使用ComfyUI 呢")]),
            existing,
            sync.parse_ts("2026-10-27T02:24:00Z"),
            "2026-10-28",
        )
        self.assertIn("4. GitHub Issue #19 新评论（2026-10-28）：@chuansenwang 2026-10-27：什么时候可以使用ComfyUI 呢", fields[sync.FIELD_ERROR_LOG])
        self.assertIn("3. GitHub Issue #19（https://x/19）：初始登记。", fields[sync.FIELD_ERROR_LOG])
        self.assertIn("2026-10-28 同步 GitHub Issue #19 新评论（并入本行）", fields[sync.FIELD_PROGRESS])
        self.assertIn("仓库侧状态未变", fields[sync.FIELD_PROGRESS])

    def test_updated_fields_skips_old_comments(self):
        existing = row("recA", "支持接入 ComfyUI", log="1. GitHub Issue #19（https://x/19）：初始登记。")
        self.assertIsNone(
            sync.updated_fields(
                issue(19, comments=[comment("aije", "老评论", created="2026-10-10T00:00:00Z")]),
                existing,
                sync.parse_ts("2026-10-27T02:24:00Z"),
                "2026-10-28",
            )
        )

    def test_build_plan_splits_create_append_and_skip(self):
        rows = [
            row("recA", "支持接入 ComfyUI 与 RunningHub 工作流生态", log="来源：GitHub Issue #19（https://x/19）：初始登记。"),
            row("recB", "画布在多节点的状态下不那么卡顿、移动起来更丝滑", progress="2026-10-27 同步 GitHub Issue #21（并入本行）：…"),
        ]
        issues = [
            issue(19, updatedAt="2026-10-27T03:26:00Z", comments=[comment("chuansenwang", "什么时候可以使用ComfyUI 呢")]),
            issue(21, updatedAt="2026-10-10T00:00:00Z"),
            issue(200, title="[Bug] 全新的问题"),
            issue(201, state="CLOSED"),
        ]
        plan = sync.build_plan(issues, rows, sync.parse_ts("2026-10-27T02:24:00Z"), "2026-10-28")
        self.assertEqual(list(plan["update_records"]), ["recA"])
        self.assertEqual(len(plan["create_records"]), 1)
        self.assertEqual(sync.ISSUE_MARKER.search(plan["create_records"][0][sync.FIELD_ERROR_LOG]).group(1), "200")
        self.assertTrue(any("#21" in note for note in plan["notes"]))
        self.assertTrue(any("#201" in note for note in plan["notes"]))

    def test_near_duplicate_hint_points_at_the_existing_row(self):
        rows = [row("recA", "支持接入 ComfyUI 与 RunningHub 工作流生态")]
        plan = sync.build_plan(
            [issue(200, title="[Feature] 支持接入 ComfyUI 工作流", body="希望在 BeefTV 内接入 ComfyUI 工作流。")],
            rows,
            sync.parse_ts("2026-10-27T02:24:00Z"),
            "2026-10-28",
        )
        self.assertTrue(any("recA" in hint for hint in plan["near_duplicates"]))


class ApplyTests(unittest.TestCase):
    def test_apply_and_verify_round_trip(self):
        feishu = FakeFeishu(
            rows=[
                row(
                    "recA",
                    "支持接入 ComfyUI 与 RunningHub 工作流生态",
                    log="1. 群友反馈。\n2. 历史反馈。\n3. GitHub Issue #19（https://x/19）：初始登记。",
                )
            ],
            issues=[
                issue(19, updatedAt="2026-10-27T03:26:00Z", comments=[comment("chuansenwang", "什么时候可以使用ComfyUI 呢")]),
                issue(200, title="[Bug] 全新的问题"),
            ],
        )
        with tempfile.TemporaryDirectory() as workdir:
            state = Path(workdir, "state.json")
            code = sync.main(
                [
                    "--since", "2026-10-27T02:24:00Z",
                    "--state", str(state),
                    "--workdir", workdir,
                    "--apply",
                ],
                runner=feishu.runner,
            )
            self.assertEqual(code, 0)
            self.assertEqual(len(feishu.rows), 2)
            created = next(r for r in feishu.rows if r["record_id"].startswith("recNEW"))
            self.assertEqual(created[REQUIREMENT], "全新的问题")
            updated = next(r for r in feishu.rows if r["record_id"] == "recA")
            self.assertIn("4. GitHub Issue #19 新评论", updated[LOG])
            self.assertEqual(json.loads(state.read_text())["previousSyncAt"], "2026-10-27T02:24:00+00:00")

    def test_verify_reports_missing_append(self):
        plan = {
            "since": "2026-10-27T02:24:00+00:00",
            "create_records": [],
            "update_records": {"recA": {sync.FIELD_ERROR_LOG: "老内容\n\n新段落", sync.FIELD_PROGRESS: "老内容\n\n新进度"}},
        }
        feishu = FakeFeishu(rows=[row("recA", "画布卡顿", log="老内容", progress="老内容")], issues=[])
        with tempfile.TemporaryDirectory() as workdir:
            problems = sync.verify_plan(feishu.runner, plan, workdir, attempts=1)
        self.assertTrue(any("报错日志" in problem for problem in problems))


    def test_verify_retries_after_a_stale_read(self):
        plan = {
            "since": "2026-10-27T02:24:00+00:00",
            "create_records": [],
            "update_records": {"recA": {sync.FIELD_ERROR_LOG: "老\n\n新段落", sync.FIELD_PROGRESS: "老\n\n新进度"}},
        }
        feishu = FakeFeishu(rows=[row("recA", "画布卡顿", log="老", progress="老")], issues=[])
        real, reads = feishu.runner, []

        def flaky(args, cwd=None):
            if args[2] == "+record-list":
                reads.append(1)
                if len(reads) == 1:
                    Path(cwd, "table.ndjson").write_text(json.dumps(row("recA", "画布卡顿", log="老", progress="老"), ensure_ascii=False))
                    return "{}"
                for existing in feishu.rows:
                    if existing["record_id"] == "recA":
                        existing[LOG], existing[PROGRESS] = "老\n\n新段落", "老\n\n新进度"
            return real(args, cwd)

        with tempfile.TemporaryDirectory() as workdir:
            problems = sync.verify_plan(flaky, plan, workdir, attempts=2, pause=0)
        self.assertEqual(problems, [])
        self.assertEqual(len(reads), 2)


if __name__ == "__main__":
    unittest.main()
