// Base contract for router drivers.
//
// A router driver inspects the router's WAN state and decides whether the
// currently-detected public IP is safe to publish to DNS. The core knows
// nothing about any specific router — it only consumes the verdict below.
//
// evaluate() returns:
//   {
//     ok:          boolean,  // could we determine the WAN state at all?
//     publishable: boolean,  // is the current connection a real, routable public IP?
//     reason:      string,   // human-readable explanation (logged / emailed)
//     detail?:     object    // optional driver-specific diagnostics
//   }
//
// Semantics the core relies on:
//   ok === false                       -> could not determine; caller FAILS OPEN (updates as normal)
//   ok === true && publishable === false -> positively behind CGNAT / on failover; caller SKIPS the update
//   ok === true && publishable === true  -> healthy public connection; caller proceeds
export default class RouterDriver {
  static driverName = 'base';

  constructor(options = {}, logger = () => {}) {
    this.options = options;
    this.logger = logger;
  }

  get name() {
    return this.constructor.driverName;
  }

  // eslint-disable-next-line no-unused-vars
  async evaluate(detectedIp) {
    throw new Error(`${this.name}: evaluate() not implemented`);
  }
}
