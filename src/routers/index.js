import AsuswrtMerlin from './AsuswrtMerlin.js';

// Registry of available router drivers. Add new routers here, keyed by the
// value users put in `router.driver` in config.json.
const REGISTRY = {
  [AsuswrtMerlin.driverName]: AsuswrtMerlin,
};

export const availableDrivers = Object.keys(REGISTRY);

// Opt-in: returns null when there is no `router` block (or no driver) in config,
// in which case the client behaves exactly as it did before this feature existed.
export function createRouterDriver(Config, logger = () => {}) {
  const routerConfig = Config.get('router');
  if (!routerConfig || !routerConfig.driver) return null;

  const Driver = REGISTRY[routerConfig.driver];
  if (!Driver) {
    logger(
      `Unknown router driver "${routerConfig.driver}". Available: ${availableDrivers.join(', ')}. Ignoring router guard.`,
      'error'
    );
    return null;
  }
  return new Driver(routerConfig.options || {}, logger);
}
