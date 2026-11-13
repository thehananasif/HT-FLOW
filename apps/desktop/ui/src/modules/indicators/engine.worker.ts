/**
 * Stage 8 indicator engine worker. Runs IndicatorRuntimes for the main thread (protocol in
 * @htflow/indicator-sdk engine.ts). User scripts are compiled here by the HT Script interpreter,
 * which has no access to anything but bar data — and a worker has no DOM in the first place.
 */
import { EngineHost, transferables, type ToEngine } from '@htflow/indicator-sdk';
import { indicatorById } from '@htflow/indicators';

interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const host = new EngineHost(indicatorById);

scope.onmessage = (e) => {
  const reply = host.handle(e.data);
  if (reply) scope.postMessage(reply, transferables(reply));
};
