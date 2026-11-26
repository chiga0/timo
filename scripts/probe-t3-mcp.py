#!/usr/bin/env python3
"""Exercise a pinned T3 binary on loopback with disposable OAuth grants and Git fixtures."""

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

if len(sys.argv) != 2:
    raise SystemExit(f'Usage: {sys.argv[0]} /absolute/path/to/t3')

binary = str(Path(sys.argv[1]).resolve(strict=True))
print(subprocess.check_output([binary, '--version'], text=True).strip(), flush=True)
with tempfile.TemporaryDirectory(prefix='timo-m0-') as tmp:
    root = Path(tmp).resolve()
    os.environ['T3CODE_HOME'] = str(root / 't3')
    project = root / 'workspace'
    project.mkdir()
    repos = [project / 'a', project / 'b']
    expected = {}

    def command(args):
        p = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=20)
        if p.returncode:
            raise RuntimeError(f'{args[0]} {args[1]} failed ({p.returncode})')
        return p.stdout

    for repo in repos:
        command(['git', 'init', '-q', '--template=', '-b', 'main', str(repo)])
        (repo/'data.txt').write_text(repo.name)
        command(['git', '-C', str(repo), 'add', 'data.txt'])
        command(['git', '-C', str(repo), '-c', 'user.name=Timo Fixture',
                 '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
                 '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'])
        expected[repo.name] = command(['git', '-C', str(repo), 'rev-parse', 'HEAD']).strip()
    command(['git', '-C', str(repos[0]), 'branch', 'probe-base'])
    branch_sha = expected['a']
    command(['git', '-C', str(repos[0]), '-c', 'user.name=Timo Fixture',
             '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
             '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'advance main'])
    expected['a'] = command(['git', '-C', str(repos[0]), 'rev-parse', 'HEAD']).strip()
    assert branch_sha != expected['a']
    shared_file = project / 'shared.txt'
    shared_file.write_text('shared fixture\n')

    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    def t3(*args):
        return [binary, *args, '--base-dir', str(root/'t3')]

    def http(path, payload=None, *, headers=None, form=False):
        hdr = dict(headers or {})
        body = None
        if payload is not None:
            hdr['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
            body = (urlencode(payload) if form else json.dumps(payload)).encode()
        try:
            response = urlopen(Request(origin+path, body, hdr), timeout=8)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            if 'text/event-stream' in response.headers.get('Content-Type',''):
                raw = next(line[6:] for line in raw.splitlines() if line.startswith(b'data: '))
            return response.status, response.headers, raw

    def json_http(path, payload=None, *, form=False, status=200):
        code, _, data = http(path, payload, form=form)
        assert code == status, (path, code)
        return json.loads(data)

    def stop(proc):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(4)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()

    def start():
        proc = subprocess.Popen(t3('serve','--host','127.0.0.1','--port',str(port),str(project)),
                                cwd=root, start_new_session=True, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        try:
            for _ in range(80):
                if proc.poll() is not None:
                    raise RuntimeError(f'T3 exit {proc.returncode}')
                try:
                    code = http('/.well-known/oauth-protected-resource/mcp')[0]
                    if code == 200:
                        return proc
                    if code != 503:
                        raise RuntimeError(f'OAuth health HTTP {code}')
                    time.sleep(.2)
                except URLError:
                    time.sleep(.2)
            raise RuntimeError('T3 startup timeout')
        except BaseException:
            stop(proc)
            raise

    def approve(access):
        redirect = 'http://127.0.0.1:48197/timo-callback'
        client = json_http('/oauth/mcp/register', {'client_name':'Timo M0 fixture',
                           'redirect_uris':[redirect]}, status=201)
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(24)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        authorization = {'response_type':'code','client_id':client['client_id'],
                         'redirect_uri':redirect,'code_challenge':challenge,
                         'code_challenge_method':'S256','state':state,'resource':origin+'/mcp'}
        scopes = ['--scope','orchestration:read']
        if access == 'approval-required':
            scopes += ['--scope','orchestration:operate']
        pairing = json.loads(command(t3('auth','pairing','create','--json',*scopes)))
        decision = json_http('/oauth/mcp/decision', {'authorization':authorization,
                             'decision':{'_tag':'pairing-code','access':access,
                                         'code':pairing['credential']}})
        callback = urlsplit(decision['redirectTo'])
        params = parse_qs(callback.query)
        assert callback._replace(query='').geturl() == redirect and params['state']==[state]
        return json_http('/oauth/mcp/token', {'grant_type':'authorization_code',
                         'code':params['code'][0], 'redirect_uri':redirect,'client_id':client['client_id'],
                         'code_verifier':verifier,'resource':origin+'/mcp'}, form=True)['access_token']

    class Client:
        def __init__(self, token):
            self.headers = {'Accept':'application/json, text/event-stream',
                            'Authorization':'Bearer '+token}
            code, hdr, raw = self.rpc('initialize', {'protocolVersion':'2025-06-18',
                'capabilities':{},'clientInfo':{'name':'timo-m0','version':'0.0.1'}})
            assert code == 200, ('initialize',code)
            self.headers['mcp-session-id'] = hdr['mcp-session-id']
            self.headers['mcp-protocol-version'] = json.loads(raw)['result']['protocolVersion']
            assert self.rpc('notifications/initialized', {}, notify=True)[0] == 202

        def rpc(self, method, params, notify=False):
            body = {'jsonrpc':'2.0','method':method,'params':params}
            if not notify:
                body['id'] = 1
            return http('/mcp',body,headers=self.headers)

        def call(self, name, args, allow_error=False):
            code, _, raw = self.rpc('tools/call',{'name':name,'arguments':args})
            assert code == 200, (name,code)
            result = json.loads(raw)
            error = 'error' in result or result.get('result',{}).get('isError',False)
            if allow_error:
                assert error, name
                return
            assert not error, (name, result.get('error',{}).get('code'), 'MCP tool rejected fixture')
            return result['result']['structuredContent']

    def resolved_worktree(client, thread_id):
        for _ in range(50):
            result = client.call('t3_thread_read', {'threadId': thread_id})
            path = result['thread']['worktreePath']
            if path is not None:
                return Path(path)
            time.sleep(.2)
        raise RuntimeError('Workspace never became ready')

    proc = start()
    try:
        command(t3('project','add',str(project),'--title','Timo Fixture'))
        assert http('/mcp',{'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})[0] == 401
        reader_token = approve('read-only')
        reader = Client(reader_token)
        operator_token = approve('approval-required')
        operator = Client(operator_token)
        status, _, discovery = operator.rpc('tools/list', {})
        assert status == 200
        required = {'t3_project_list', 't3_thread_launch', 't3_thread_read',
                    't3_thread_wait', 't3_thread_send', 't3_thread_interrupt',
                    'orchestrator_capabilities'}
        tools = json.loads(discovery)['result']['tools']
        assert required <= {entry['name'] for entry in tools}
        projects = reader.call('t3_project_list',{})['projects']
        project_id = projects[0]['id']
        capabilities = operator.call('orchestrator_capabilities',{})
        provider = next(p for p in capabilities['providers'] if p['models'])
        launch = {'modelSelection':{'instanceId':provider['providerInstanceId'],'model':provider['models'][0]['id']},
                  'projectId':project_id,'title':'Timo fixture, no model invocation',
                  'runtimeMode':'approval-required', 'clientRequestId':'timo-m0-dual-repo',
                  'workspaceStrategy':{'type':'worktree','baseRef':'main','branch':'timo-fixture',
                                       'startFromOrigin':False,
                                       'repositories':[{'path':str(path)} for path in repos]}}
        reader.call('t3_thread_launch',launch, allow_error=True)
        print('Anonymous rejected; read-only can list projects and cannot launch',flush=True)
        launched = operator.call('t3_thread_launch',launch)
        thread_id = launched['threadId']
        assert launched['runId'] is None
        assert operator.call('t3_thread_launch', launch)['threadId'] == thread_id
        worktree = resolved_worktree(reader, thread_id)
        for name, sha in expected.items():
            assert command(['git','-C',str(worktree/name),'rev-parse','HEAD']).strip() == sha
        assert operator.call('t3_thread_wait',{'threadId':thread_id,'timeoutMs':200})['status']=='idle'
        assert operator.call('t3_thread_interrupt',{'threadId':thread_id})['status']=='no_active_run'
        print('Scoped OAuth idle launch; same-key replay; two HEADs; read/wait; idle interrupt',flush=True)
        reader.call('t3_thread_read', {'threadId': 'timo-nonexistent-thread'}, allow_error=True)
        operator.call('t3_thread_launch', {
            **launch,
            'clientRequestId': 'timo-m0-missing-provider',
            'modelSelection': {'instanceId': 'timo-nonexistent-provider', 'model': 'fixture'},
        }, allow_error=True)
        print('Missing thread and provider explicitly rejected', flush=True)
        fallback_launch = {
            **launch,
            'clientRequestId': 'timo-m0-fallback',
            'workspaceStrategy': {
                **launch['workspaceStrategy'],
                'baseRef': 'probe-base',
                'branch': 'timo-fallback',
            },
        }
        fallback_thread = operator.call('t3_thread_launch', fallback_launch)['threadId']
        fallback_worktree = resolved_worktree(reader, fallback_thread)
        for name, sha in {**expected, 'a': branch_sha}.items():
            assert command(['git', '-C', str(fallback_worktree / name), 'rev-parse', 'HEAD']).strip() == sha
        assert command(['git', '-C', str(repos[1]), 'branch', '--list', 'probe-base']).strip() == ''
        for checkout in (worktree, fallback_worktree):
            shared = checkout / shared_file.name
            assert shared.is_symlink() and shared.resolve() == shared_file
        print('Missing base branch fell back to original default; shared file points to original', flush=True)
    finally:
        stop(proc)

    proc = start()
    try:
        restarted = Client(operator_token)
        assert restarted.call('t3_thread_read',{'threadId':thread_id})['thread']['worktreePath']==str(worktree)
        assert restarted.call('t3_thread_launch',launch)['threadId'] == thread_id
        new_token = approve('approval-required')
        assert Client(new_token).call('t3_thread_launch',launch)['threadId'] != thread_id
        print('Restart re-read; same OAuth token replays same ID; new grant changes ID',flush=True)
        assert http('/oauth/mcp/revoke', {'token':reader_token}, form=True)[0] == 200
        assert reader.rpc('tools/list',{})[0] == 401
        print('Revoked read-only token rejected',flush=True)
    finally:
        stop(proc)
