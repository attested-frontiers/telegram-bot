const { formatUSDC, txLink, createDepositKeyboard } = require('../../utils');
const config = require('../../config');

async function handleDepositReceived(parsed, log, db, bot) {
  const { depositId, depositor, token, amount, intentAmountRange } = parsed.args;
  const id = Number(depositId);
  const usdcAmount = Number(amount);

  console.log(`💰 DepositReceived: ${id} with ${formatUSDC(amount)} USDC`);

  // Store the deposit amount for later sniper use
  await db.storeDepositAmount(id, usdcAmount);

  // Check if this deposit is from a samba contract
  console.log(`🔍 Checking if deposit ${id} is from samba contract: ${depositor}`);
  const isSambaContract = await db.isSambaContract(depositor);
  console.log("Result: ", isSambaContract);
  if (!isSambaContract) {
    console.log(`🚫 Deposit ${id} not from samba contract ${depositor} - ignoring`);
    return;
  }

  console.log(`✅ Deposit ${id} is from samba contract ${depositor} - processing`);

  // Send notification for new deposits from samba contracts
  console.log(`📢 Sending new deposit notification`);

  const message = `
💰 *New Samba Deposit to Market Make*
• *Deposit ID:* \`${id}\`
• *Swap Contract:* \`${depositor}\`
• *Amount:* ${formatUSDC(amount)} USDC
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();
  const sendOptions = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: createDepositKeyboard(id),
    message_thread_id: config.SAMBA_TOPIC_ID
  };

  bot.sendMessage(config.ATTESTED_GROUP_ID, message, sendOptions);

}

async function handleDepositWithdrawn(parsed, log) {
  const { depositId, depositor, amount } = parsed.args;
  const id = Number(depositId);
  const { formatUSDC } = require('../../utils');

  console.log(`💸 DepositWithdrawn: ${formatUSDC(amount)} USDC from deposit ${id} by ${depositor} - ignored`);
}

async function handleDepositClosed(parsed, log) {
  const { depositId, depositor } = parsed.args;
  const id = Number(depositId);

  console.log(`🔒 DepositClosed: deposit ${id} by ${depositor} - ignored`);
}

module.exports = {
  handleDepositReceived,
  handleDepositWithdrawn,
  handleDepositClosed
};