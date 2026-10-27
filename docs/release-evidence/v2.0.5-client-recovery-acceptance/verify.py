"""复核本轮保存的原任务、交付和重启证据；画面仍需人工查看原始截图。"""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent
def read(name): return json.loads((root / name).read_text())
before = read('before.json')
pending = read('before-download.json')
after = read('after-download.json')
restart = read('final-state.json')
resource = read('resource.json')
assert before['task']['status'] == 'failed'
assert before['task']['outcome']['phase'] == 'retrievable'
assert pending['counts']['resources'] == 0
assert pending['canvases'][0]['document']['nodes'][0]['metadata']['status'] == 'loading'
for state in [after, restart]:
    assert state['counts'] == dict(tasks=1, route_attempts=0, resources=1, results=1, api_call_logs=1)
    task = state['tasks'][0]
    assert task['id'] == before['task']['id'] and task['route_run'] == before['routeRun'] == 3
    assert task['attempts'] == 0 and task['status'] == 'succeeded'
    canvas = state['canvases'][0]
    assert canvas['id'] == before['canvas']['id'] and canvas['revision'] == 3
    node = canvas['document']['nodes'][0]
    assert node['id'] == 'n1' and node['metadata']['status'] == 'success'
    assert node['metadata']['storageKey'] == 'resource:' + resource['resourceId']
    assert node['metadata']['naturalWidth'] == resource['width'] == 320
    assert node['metadata']['naturalHeight'] == resource['height'] == 200
    assert state['receipts'][0]['id'] == 'v205-client-receipt'
events = [json.loads(line) for line in (root/'upstream.jsonl').read_text().splitlines()]
requests = [e for e in events if e['event'] == 'request']
assert len(requests) == 2 and all(e['method'] == 'GET' for e in requests)
assert not any(e.get('method') == 'POST' for e in events)
assert after['runtime']['pid'] == 62834 and restart['runtime']['pid'] == 84171
assert read('upstream-stopped.json')['stoppedAt'] < restart['observedAt']
print('通过：原任务与轮次不变；完整画布交付；零 POST；断开假上游后重启无重复资源。')
