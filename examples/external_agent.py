"""Dependency-free Python adapter. Run using CLI supervise."""
import json
import os
import time
import urllib.request
import urllib.error

BASE = os.environ['LAB_URL']
TOKEN = os.environ['LAB_TOKEN']
CONFIG = json.loads(os.environ['LAB_CONFIG'])

def api(path, body=None, timeout=3):
    request = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Lab-Token': TOKEN})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)

def tool(name, order):
    operation = f'order-{order}:{name}'
    for attempt in range(CONFIG['maxAttempts']):
        try:
            return api('/tools/' + name, {'operation': operation,
                'idempotencyKey': operation}, CONFIG['requestTimeoutMs'] / 1000)
        except (OSError, ValueError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in (408, 429, 500, 502, 503, 504):
                raise
            if attempt + 1 == CONFIG['maxAttempts']:
                raise
            api('/agent-events', {'type': 'agent.retry', 'operation': operation,
                'tool': name, 'attempt': attempt + 1, 'code': 'TRANSIENT_ERROR'})
            retry_after = float(error.headers.get('Retry-After', 0)) if isinstance(error, urllib.error.HTTPError) else 0
            time.sleep(max(retry_after, min(.08 * 2 ** attempt, .64)))

checkpoint = api('/checkpoint')
for order in range(1, CONFIG['orders'] + 1):
    if order in checkpoint['completed']:
        continue
    result = tool('charge', order)
    seen = set()
    for message in result['deliveries']:
        if message['messageId'] in seen:
            continue
        seen.add(message['messageId'])
        tool('receipt', order)
    checkpoint['completed'].append(order)
    api('/checkpoint', checkpoint)
