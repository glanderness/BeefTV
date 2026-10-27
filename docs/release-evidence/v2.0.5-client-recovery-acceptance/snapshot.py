"""只读导出本任务的隔离 SQLite；不读取正式数据目录或任何凭据。"""
import json
import pathlib
import sqlite3
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
db = sqlite3.connect(f'file:{root / "open_ai_canvas.db"}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
def rows(sql): return [dict(row) for row in db.execute(sql)]
tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
state = dict(observedAt=time.time(),
    tasks=rows("select id,user_id,project_id,type,status,stage,route_run,attempts,error,recovery_outcome,next_poll_at,input_json,result_json from tasks"),
    canvases=rows("select id,title,revision,payload_json from canvas_projects"),
    receipts=rows("select id,task_id,request_kind,method,status,status_code,response_body from api_call_logs"),
    counts={t:db.execute(f'select count(*) from {t}').fetchone()[0] for t in ['tasks','route_attempts','resources','results','api_call_logs'] if t in tables})
for canvas in state['canvases']:
    canvas['document'] = json.loads(canvas.pop('payload_json'))
runtime = root/'runtime.json'
if runtime.exists(): state['runtime'] = json.loads(runtime.read_text())
print(json.dumps(state,ensure_ascii=False,indent=2))
