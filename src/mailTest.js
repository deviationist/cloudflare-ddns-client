import Mailer from './Mailer.js';
import Config from './Config.js';
import yargs from 'yargs';

const argv = yargs(process.argv).argv;
const configPath = argv.configPath;
if (configPath) Config.filePath = configPath;

const mailer = new Mailer(Config);

if (!mailer.isConfigured()) {
  console.log('mailConfig.fromAddress or mailConfig.password is not configured');
  process.exit(1);
}

const toAddress = Config.get('errorRecipientMailAddress');
if (!toAddress) {
  console.log('errorRecipientMailAddress is not configured');
  process.exit(1);
}

try {
  const subject = Mailer.generateSubject('Email test', Config.get('serviceId'));
  const message = `This is a test email from ${serviceName}.`;
  console.log('Sending email from', mailer.fromAddress);
  console.log('Sending email to', toAddress);
  console.log('Subject:', subject);
  console.log('Message:', message);
  await mailer.send(
    toAddress, 
    subject,
    message
  );
  console.log('Mail sent!');
} catch(error) {
  console.error('Error sending mail. Error: ', error);
}