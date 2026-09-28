import { listTrades } from './list.js';
import { previewTrade } from './preview.js';
import { counterTradeOperation, proposeTradeOperation } from './propose.js';
import { respondToTrade, voteTrade, withdrawTradeOperation } from './respond.js';

/** Trades (#63, #64, #65, #79): preview, offers and counters, answers, league review, and the list. */
export const tradeOperations = [
  previewTrade,
  proposeTradeOperation,
  counterTradeOperation,
  respondToTrade,
  withdrawTradeOperation,
  voteTrade,
  listTrades
];
