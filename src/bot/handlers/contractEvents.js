const { iface } = require('../../blockchain');
const { eventProcessors } = require('../../blockchain');
const { getFiatCode, formatConversionRate, formatUSDC, formatTimestamp, getPlatformName, txLink, createDepositKeyboard } = require('../../utils');
const config = require('../../config');
const { db } = require('../../database');

// Event handler function
const createContractEventHandler = (bot) => {
  return async (log) => {
    console.log('\n📦 Raw log received:');
    console.log(log);

    try {
      const parsed = iface.parseLog({
        data: log.data,
        topics: log.topics
      });

      if (!parsed) {
        console.log('⚠️ Log format did not match our ABI');
        console.log('📝 Event signature:', log.topics[0]);

        if (log.topics.length >= 3) {
          const topicDepositId = parseInt(log.topics[2], 16);
          console.log('📊 Extracted deposit ID from topic:', topicDepositId);

          // const interestedUsers = await db.getUsersInterestedInDeposit(topicDepositId);
          // if (interestedUsers.length > 0) {
          console.log(`⚠️ Sending unrecognized event to ${interestedUsers.length} users`);

          const message = `
⚠️ *Unrecognized Event for Deposit*
• *Deposit ID:* \`${topicDepositId}\`
• *Event Signature:* \`${log.topics[0]}\`
• *Block:* ${log.blockNumber}
• *Tx:* [View on BaseScan](${txLink(log.transactionHash)})
`.trim();
          console.log("Step 1", config.ATTESTED_GROUP_ID, config.SAMBA_TOPIC_ID)
          const result = await bot.sendMessage(config.ATTESTED_GROUP_ID, 'test2', {
            message_thread_id: config.SAMBA_TOPIC_ID,
            parse_mode: 'Markdown',
          });
          console.log("Step 2")
          await bot.sendMessage(config.ATTESTED_GROUP_ID, '🤖 hmmmmm!', {
            message_thread_id: config.SAMBA_TOPIC_ID,
            parse_mode: 'Markdown',
          });
          console.log("Step 3")
          await bot.sendMessage(config.ATTESTED_GROUP_ID, message, {
            message_thread_id: config.SAMBA_TOPIC_ID,
            // disable_web_page_preview: true,
            parse_mode: 'Markdown',
            // reply_markup: createDepositKeyboard(topicDepositId)
          });
        }
        return;
      }

      console.log('✅ Parsed log:', parsed.name);
      console.log('🔍 Args:', parsed.args);

      const { name } = parsed;

      if (name === 'IntentSignaled') {
        const { intentHash, depositId, verifier, owner, to, amount, fiatCurrency, conversionRate, timestamp } = parsed.args;
        const id = Number(depositId);

        console.log('🧪 IntentSignaled depositId:', id);

        // Store intent details for later use in notifications
        eventProcessors.storeIntentDetails(intentHash, fiatCurrency, conversionRate, verifier);
      }

      if (name === 'IntentFulfilled') {
        const { intentHash, depositId, verifier, owner, to, amount, sustainabilityFee, verifierFee } = parsed.args;
        const txHash = log.transactionHash;
        const id = Number(depositId);

        console.log('🧪 IntentFulfilled collected for batching - depositId:', id);

        eventProcessors.transactionBatcher.addFulfilledIntent(
          txHash,
          intentHash,
          { depositId: id, verifier, owner, to, amount, sustainabilityFee, verifierFee, intentHash },
          log.blockNumber
        );

        // Schedule processing this transaction
        eventProcessors.transactionBatcher.scheduleTransactionProcessing(
          txHash,
          (hash) => eventProcessors.processCompletedTransaction(hash, db, bot, createDepositKeyboard)
        );
      }

      if (name === 'IntentPruned') {
        const { intentHash, depositId } = parsed.args;
        const txHash = log.transactionHash;
        const id = Number(depositId);

        console.log('🧪 IntentPruned collected for batching - depositId:', id);

        eventProcessors.transactionBatcher.addPrunedIntent(
          txHash,
          intentHash,
          { depositId: id, intentHash },
          log.blockNumber
        );

        // Schedule processing this transaction
        eventProcessors.transactionBatcher.scheduleTransactionProcessing(
          txHash,
          (hash) => eventProcessors.processCompletedTransaction(hash, db, bot, createDepositKeyboard)
        );
      }

      if (name === 'DepositWithdrawn') {
        await eventProcessors.handleDepositWithdrawn(parsed, log);
        return;
      }

      if (name === 'DepositClosed') {
        await eventProcessors.handleDepositClosed(parsed, log);
        return;
      }

      if (name === 'BeforeExecution') {
        console.log(`🛠️ BeforeExecution event detected at block ${log.blockNumber}`);
        return;
      }

      if (name === 'UserOperationEvent') {
        const { userOpHash, sender, paymaster, nonce, success, actualGasCost, actualGasUsed } = parsed.args;
        console.log(`📡 UserOperationEvent:
  • Hash: ${userOpHash}
  • Sender: ${sender}
  • Paymaster: ${paymaster}
  • Nonce: ${nonce}
  • Success: ${success}
  • Gas Used: ${actualGasUsed}
  • Gas Cost: ${actualGasCost}
  • Block: ${log.blockNumber}`);
        return;
      }

      if (name === 'DepositCurrencyRateUpdated') {
        const { depositId, verifier, currency, conversionRate } = parsed.args;
        const id = Number(depositId);
        const fiatCode = getFiatCode(currency);
        const rate = (Number(conversionRate) / 1e18).toFixed(6);
        const platform = getPlatformName(verifier);

        console.log(`📶 DepositCurrencyRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);

      }

      if (name === 'DepositConversionRateUpdated') {
        const { depositId, verifier, currency, newConversionRate } = parsed.args;
        const id = Number(depositId);
        const fiatCode = getFiatCode(currency);
        const rate = (Number(newConversionRate) / 1e18).toFixed(6);
        const platform = getPlatformName(verifier);

        console.log(`📶 DepositConversionRateUpdated - ID: ${id}, ${platform}, ${fiatCode} rate updated to ${rate}`);

      }

      if (name === 'DepositReceived') {
        await eventProcessors.handleDepositReceived(parsed, log, db, bot);
      }

      // Handle DepositCurrencyAdded
      if (name === 'DepositCurrencyAdded') {
        const { depositId, verifier, currency, conversionRate } = parsed.args;
        const id = Number(depositId);

        console.log('📦 DepositCurrencyAdded detected:', id);

        // Get the actual deposit amount
        const depositAmount = await db.getDepositAmount(id);
        console.log(`💰 Retrieved deposit amount: ${depositAmount} (${formatUSDC(depositAmount)} USDC)`);
      }

    } catch (err) {
      console.error('❌ Failed to parse log:', err.message);
      console.log('👀 Raw log (unparsed):', log);
      console.log('📝 Topics received:', log.topics);
      console.log('📝 First topic (event signature):', log.topics[0]);
      console.log('🔄 Continuing to listen for other events...');
    }
  };
};

module.exports = {
  createContractEventHandler
};