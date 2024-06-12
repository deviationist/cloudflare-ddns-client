import { serviceName } from './Constants.js';
import Mailer from './Mailer.js';

export default class ErrorHandler {
  errors = [];
  config;
  logger;
  verbose;
  mailer;

  constructor(Config, verbose = false, logger ) {
    this.config = Config;
    this.verbose = verbose;
    this.logger = logger;
    this.mailer = new Mailer(Config);
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  add(error) {
    this.errors.push(error);
    if (this.verbose) this.logger(error.message, 'error');
    return this;
  }

  async handle(exitAfter = true) {
    if (!this.mailer.isConfigured()) return; // Missing config
    if (this.errors.length === 0) return;
    const toAddress = this.config.get('errorRecipientMailAddress');
    if (!toAddress) return; // Missing config
    const serviceId = this.config.get('serviceId');
    try {

      
      await this.mailer.send(
        toAddress,
        Mailer.generateSubject(this.errors.length > 1 ? 'Multiple errors' : 'Error', serviceId)
        `There seems to be an issue with the ${serviceName}${serviceId ? ` (${serviceId})` : ''}. See error messages below: \n${this.errors.map(error => `- ${error.message}`).join('\n')}`
      );
    } catch(error) {
      this.logger('Could not send error mail')
    }
    if (exitAfter) process.exit(1);
  }
}