import nodemailer from 'nodemailer';
import { serviceName } from './Constants.js';

export default class Mailer {
  client = null;
  fromAddress;
  config;

  static generateSubject(subject, serviceId) {
    return `${subject} - ${serviceName}${serviceId ? ` (${serviceId})` : ''}`;
  };

  constructor(Config) {
    this.config = Config.get('mailConfig');
    const smtp = this.config?.smtp;
    if (!this.config?.fromAddress || !smtp?.login || !smtp?.password) return;
    this.fromAddress = this.config.fromAddress;
    this.client = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port ?? 587,
      secure: smtp.secure ?? false,
      auth: {
        user: smtp.login,
        pass: smtp.password
      }
    });
  }

  isConfigured() {
    return this.client !== null;
  }

  async send(toAddress, subject, message) {
    return this.client.sendMail({
      from: this.fromAddress,
      to: toAddress,
      subject,
      text: message
    });
  }
}