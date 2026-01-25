import { EmailClient } from '../src/email/client.js';

const client = new EmailClient();

async function test() {
  const to = process.argv[2] || 'test@bjola.ca';

  try {
    const messageId = await client.send({
      to,
      subject: 'CarGuru Email Test - ' + new Date().toLocaleString(),
      text: `This is a test email from the CarGuru search automation system.

If you received this, email sending is working correctly.

Timestamp: ${new Date().toISOString()}`,
    });
    console.log('✅ Test email sent to', to);
    console.log('   Message ID:', messageId);
    client.close();
  } catch (error: any) {
    console.error('❌ Failed to send:', error.message);
    process.exit(1);
  }
}

test();
