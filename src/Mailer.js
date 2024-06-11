import nodemailer from 'nodemailer';

export default class Mailer {
  client = null;
  fromAddress;
  config;

  constructor(Config) {
    this.config = Config.get('mailConfig');
    if (!this.config.fromAddress || !this.config.password) return; // Missing config
    this.fromAddress = this.config.fromAddress;
    this.client = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
          user: this.fromAddress,
          pass: this.config.password
      }
    });
  }

  isConfigured() {
    return this.client !== null;
  }

  async send(toAddress, subject, message) {
    return this.client.sendMail({
      to: toAddress,
      subject,
      text: message
    });
  }
}