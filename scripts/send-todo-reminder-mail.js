process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';
require('dotenv').config({ quiet: true });

const db = require('../database');
const {
  createTodoReminderEmailMessage,
  getDueTodosForReminder,
  getBusinessClockParts,
  sendTodoReminderEmail,
  sortTodosForReminder,
} = require('../server');

function parseArgs(argv) {
  const options = {
    to: '',
    date: '',
    allOpen: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all-open') {
      options.allOpen = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--to' && argv[i + 1]) {
      options.to = argv[++i];
      continue;
    }
    if (arg.startsWith('--to=')) {
      options.to = arg.slice('--to='.length);
      continue;
    }
    if (arg === '--date' && argv[i + 1]) {
      options.date = argv[++i];
      continue;
    }
    if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const businessDate = options.date || getBusinessClockParts().businessDate;
  const recipient = options.to || process.env.TODO_REMINDER_TEST_TO || process.env.QQ_EMAIL_ACCOUNT || '';
  if (!recipient) {
    throw new Error('Missing recipient email. Pass --to or set TODO_REMINDER_TEST_TO.');
  }

  const todos = getDueTodosForReminder(db, businessDate, { allOpen: options.allOpen });
  const snapshot = sortTodosForReminder(todos);
  if (!snapshot.length) {
    throw new Error(options.allOpen
      ? 'No unfinished todos available for a test email.'
      : `No unfinished todos due on ${businessDate}.`);
  }

  const mail = createTodoReminderEmailMessage({
    to: recipient,
    businessDate,
    snapshot,
  });

  if (options.dryRun) {
    process.stdout.write(JSON.stringify({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      textEncoding: mail.textEncoding,
    }, null, 2));
    return;
  }

  await sendTodoReminderEmail(mail);
  process.stdout.write(`Sent ${snapshot.length} todo item(s) to ${recipient} for ${businessDate}.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
