/// <reference lib="webworker" />
/**
 * HT Strategy sandbox worker. Runs ONLY the user's compiled strategy and the API shim
 * (SandboxCore). Before any user code is evaluated the realm is locked down (no fetch,
 * XMLHttpRequest, WebSocket, importScripts, eval, Function constructor, timers, storage); the
 * worker has no DOM by construction. The host terminates it when a callback overruns its budget.
 */
import {
  SandboxCore,
  lockdownRealm,
  type SandboxRequest,
  type SandboxResponse,
  type ScriptError,
} from '@htflow/strategy';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = scope.postMessage.bind(scope);
let core: SandboxCore | null = null;

scope.onmessage = (e: MessageEvent<SandboxRequest>) => {
  const req = e.data;
  if (!req || typeof req.seq !== 'number') return;
  let res: SandboxResponse;
  if (req.type === 'load') {
    try {
      core = new SandboxCore(req.instrument, req.limits);
      res = { seq: req.seq, type: 'loaded', description: core.load(req.project, req.params) };
    } catch (err) {
      const error: ScriptError =
        err && typeof err === 'object' && 'kind' in err
          ? (err as ScriptError)
          : { message: String(err), kind: 'load' };
      res = { seq: req.seq, type: 'loaded', error };
    }
  } else if (core) {
    res = { seq: req.seq, type: 'result', result: core.call(req.event) };
  } else {
    res = {
      seq: req.seq,
      type: 'result',
      result: {
        intents: [],
        logs: [],
        plots: [],
        ms: 0,
        error: { message: 'Sandbox not loaded', kind: 'protocol' },
      },
    };
  }
  post(res);
};

lockdownRealm();
