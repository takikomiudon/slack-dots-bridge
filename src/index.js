export class BridgeObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  fetch() {
    throw new Error('Not implemented');
  }
  alarm() {
    throw new Error('Not implemented');
  }
}
export default {
  fetch() {
    throw new Error('Not implemented');
  }
};
