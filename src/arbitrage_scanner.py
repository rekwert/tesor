import time
import math
import logging
from typing import Dict, Any, List, Tuple, Optional


from src.data_models import NormalizedTicker, NormalizedOrderBook, ArbitrageOpportunity

from src.utils import find_executable_arbitrage_volume_and_profit


from src.config import DESIRED_TRADE_VOLUME_BASE, MIN_PROFIT_PCT

# Настройка логирования
logger = logging.getLogger(__name__)


def find_arbitrage_opportunities_with_order_book(
    market_data: Dict[str, Dict[str, Any]],
    ) -> List[ArbitrageOpportunity]:

    opportunities: List[ArbitrageOpportunity] = []

    current_timestamp_ms = int(time.time() * 1000)


    orderbooks_by_symbol: Dict[str, Dict[str, NormalizedOrderBook]] = {}
    for exchange_id, data_by_symbol in market_data.items():
        if isinstance(data_by_symbol, dict):
            for symbol_key, data_item in data_by_symbol.items():
                if isinstance(symbol_key, str) and symbol_key.endswith('_ob') and isinstance(data_item, NormalizedOrderBook):
                     symbol = symbol_key[:-3]
                     if symbol not in orderbooks_by_symbol:
                         orderbooks_by_symbol[symbol] = {}
                     orderbooks_by_symbol[symbol][exchange_id] = data_item



    for symbol, exchanges_with_ob in orderbooks_by_symbol.items():
         available_exchanges = list(exchanges_with_ob.keys())

         if len(available_exchanges) < 2:
             continue

         max_volume_to_consider = DESIRED_TRADE_VOLUME_BASE.get(symbol)
         if max_volume_to_consider is None or max_volume_to_consider <= 1e-9:
             logger.warning(f"DESIRED_TRADE_VOLUME_BASE not configured or zero for {symbol}. Skipping scanning for this pair.")
             continue

         # --- Ищем двусторонние возможности (Buy on A, Sell on B) ---
         # Перебираем все уникальные пары бирж (i, j) где i != j
         for i in range(len(available_exchanges)):
            for j in range(len(available_exchanges)):
                if i == j: # Не ищем арбитраж на одной бирже
                    continue

                # --- Направление 1: Купить на available_exchanges[i], Продать на available_exchanges[j] ---
                buy_exchange_id = available_exchanges[i]
                sell_exchange_id = available_exchanges[j]

                buy_ob = exchanges_with_ob.get(buy_exchange_id)
                sell_ob = exchanges_with_ob.get(sell_exchange_id)

                if not buy_ob or not sell_ob:
                     continue

                # Вызываем функцию для поиска оптимального объема и прибыли для Направления 1
                (
                    executable_volume_base,
                    buy_executed_price,
                    sell_executed_price,
                    gross_profit_pct,
                    net_profit_pct,
                    fees_paid_quote,
                    cost_total_quote,
                    revenue_total_quote
                ) = find_executable_arbitrage_volume_and_profit(
                    buy_ob=buy_ob,
                    sell_ob=sell_ob,
                    buy_exchange_id=buy_exchange_id,
                    sell_exchange_id=sell_exchange_id,
                    min_profit_pct=MIN_PROFIT_PCT,
                    max_volume_base_limit=max_volume_to_consider
                )

                # Проверяем результат: добавляем возможность только если она найдена с Net прибылью >= MIN_PROFIT_PCT и ненулевым объемом
                if executable_volume_base > 1e-9:
                     opportunity_id = f"{symbol.replace('/', '')}-{buy_exchange_id.lower()}-{sell_exchange_id.lower()}"
                     calculated_net_profit_quote = (net_profit_pct / 100.0) * cost_total_quote if cost_total_quote > 1e-9 else 0.0

                     opportunities.append(ArbitrageOpportunity(
                         id=opportunity_id,
                         symbol=symbol,
                         buy_exchange=buy_exchange_id,
                         sell_exchange=sell_exchange_id,
                         executable_volume_base=executable_volume_base,
                         buy_price=buy_executed_price,
                         sell_price=sell_executed_price,
                         potential_profit_pct=gross_profit_pct,
                         fees_paid_quote=fees_paid_quote,
                         net_profit_pct=net_profit_pct,
                         net_profit_quote=calculated_net_profit_quote,
                         buy_network=None, # TODO
                         sell_network=None, # TODO
                         timestamp=current_timestamp_ms,
                     ))

                # --- Направление 2: Купить на available_exchanges[j], Продать на available_exchanges[i] ---
                # Меняем местами биржи покупки и продажи для обратного направления
                buy_exchange_id_rev = available_exchanges[j]
                sell_exchange_id_rev = available_exchanges[i]

                buy_ob_rev = exchanges_with_ob.get(buy_exchange_id_rev) # ОБ покупки для обратного направления
                sell_ob_rev = exchanges_with_ob.get(sell_exchange_id_rev) # ОБ продажи для обратного направления

                # Проверяем наличие книг ордеров для обратного направления
                if not buy_ob_rev or not sell_ob_rev:
                    continue

                # Вызываем функцию для обратного направления
                (
                     executable_volume_base_rev,
                     buy_executed_price_rev,
                     sell_executed_price_rev,
                     gross_profit_pct_rev,
                     net_profit_pct_rev,
                     fees_paid_quote_rev,
                     cost_total_quote_rev,
                     revenue_total_quote_rev
                ) = find_executable_arbitrage_volume_and_profit(
                     buy_ob=buy_ob_rev, # Передаем OB для покупки в этом направлении
                     sell_ob=sell_ob_rev, # Передаем OB для продажи в этом направлении
                     buy_exchange_id=buy_exchange_id_rev,
                     sell_exchange_id=sell_exchange_id_rev,
                     min_profit_pct=MIN_PROFIT_PCT,
                     max_volume_base_limit=max_volume_to_consider
                )

                # Проверяем результат для обратного направления
                if executable_volume_base_rev > 1e-9:
                     opportunity_id_rev = f"{symbol.replace('/', '')}-{buy_exchange_id_rev.lower()}-{sell_exchange_id_rev.lower()}"
                     calculated_net_profit_quote_rev = (net_profit_pct_rev / 100.0) * cost_total_quote_rev if cost_total_quote_rev > 1e-9 else 0.0

                     opportunities.append(ArbitrageOpportunity(
                         id=opportunity_id_rev,
                         symbol=symbol,
                         buy_exchange=buy_exchange_id_rev, # Биржа покупки для этого направления
                         sell_exchange=sell_exchange_id_rev, # Биржа продажи для этого направления
                         executable_volume_base=executable_volume_base_rev,
                         buy_price=buy_executed_price_rev,
                         sell_price=sell_executed_price_rev,
                         potential_profit_pct=gross_profit_pct_rev,
                         fees_paid_quote=fees_paid_quote_rev,
                         net_profit_pct=net_profit_pct_rev,
                         net_profit_quote=calculated_net_profit_quote_rev,
                         buy_network=None, # TODO
                         sell_network=None, # TODO
                         timestamp=current_timestamp_ms,
                     ))

    # Сортируем возможности по Net прибыли по убыванию перед возвратом
    opportunities.sort(key=lambda opp: opp.net_profit_pct, reverse=True)

    return opportunities