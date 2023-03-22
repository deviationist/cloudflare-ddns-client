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
}