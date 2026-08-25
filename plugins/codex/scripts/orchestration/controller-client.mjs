
import { requestController } from "./ipc.mjs";
export class OrchestrationControllerClient {
  constructor(endpoint) { this.endpoint = endpoint; }
  start(plan, context) { return requestController(this.endpoint, "orchestration/start", { plan, context }); }
  status(reference = "") { return requestController(this.endpoint, "orchestration/status", { reference }); }
  result(reference = "") { return requestController(this.endpoint, "orchestration/result", { reference }); }
  cancel(reference) { return requestController(this.endpoint, "orchestration/cancel", { reference }); }
  controllerStatus() { return requestController(this.endpoint, "controller/status", {}); }
  shutdown(force = false) { return requestController(this.endpoint, "controller/shutdown", { force }); }
}
