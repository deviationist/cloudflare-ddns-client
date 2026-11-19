import { readFileSync, existsSync } from 'fs';

export default class Config {
    static filePath = './config.json';
    static data = null;

    static get(dotNotation) {
        Config.readConfigData();
        if (!Config.data) {
            return null;
        }
        if (dotNotation) {
            return dotNotation.split('.').reduce((o, i) => o[i], Config.data);
        } else {
            return Config.data;
        }
    }

    static readConfigData() {
        if (Config.data == null) {
            if (!Config.exists()) {
                Config.data = false;
            } else {
                const dataStream = readFileSync(Config.filePath, 'utf-8');
                const configData = JSON.parse(Buffer.from(dataStream));
                if (configData) {
                    Config.data = configData;
                } else {
                    Config.data = false;
                }
            }   
        }
    }

    static exists() {
        return existsSync(Config.filePath);
    }

    // Used when neither the zone nor its item names a key, so a single-token
    // setup can keep the key out of config.json without any config at all.
    static defaultApiKeyEnv = 'CLOUDFLARE_API_TOKEN';

    // The most specific level that says anything wins: zone, then item, then
    // the default variable. At each level `apiKeyEnv` beats a literal
    // `apiKey`. A level whose `apiKeyEnv` is set but empty resolves to false
    // rather than falling through, so a missing variable can never quietly
    // send a broader level's token to a zone it wasn't meant for.
    static resolveApiKey(item, zone, env = process.env) {
        for (const level of [zone, item]) {
            if (level?.apiKeyEnv) {
                return env[level.apiKeyEnv] || false;
            }
            if (level?.apiKey) {
                return level.apiKey;
            }
        }
        return env[Config.defaultApiKeyEnv] || false;
    }

    // For the error message when resolveApiKey comes back empty: which
    // variable was it expected in?
    static apiKeyEnvName(item, zone) {
        for (const level of [zone, item]) {
            if (level?.apiKeyEnv) return level.apiKeyEnv;
            if (level?.apiKey) return null;
        }
        return Config.defaultApiKeyEnv;
    }
}