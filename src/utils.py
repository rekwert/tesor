from typing import Dict, Any, List, Tuple
from src.data_models import NormalizedTicker, NormalizedOrderBook
import math
from src.config import EXCHANGE_TAKER_FEES_PCT, MIN_PROFIT_PCT # Импортируем комиссии и порог

# ... (normalize_ccxt_ticker и normalize_ccxt_order_book остаются без изменений) ...


# Модифицируем существующую функцию calculate_executed_price, чтобы она просто
# считала среднюю цену для *данного* объема. Она пригодится внутри новой функции.
# Сделаем ее внутренним вспомогательным методом, или оставим как есть, она уже это делает.
# Оставим как есть, но будем использовать ее из новой функции.
def calculate_executed_price(order_book: NormalizedOrderBook, volume: float, side: str) -> Tuple[float, float]:
    """
    Рассчитывает средневзвешенную исполненную цену и реализуемый объем для заданного объема сделки
    (в базовой валюте), используя данные книги ордеров. Возвращает (price, volume).
    Возвращает (0, 0) если книга пуста, некорректна или volume <= 0.
    """
    if not order_book or not (order_book.asks if side == 'buy' else order_book.bids) or volume <= 1e-9:
        return 0.0, 0.0 # Возвращаем 0.0, 0.0 вместо None, None для удобства расчетов

    levels = order_book.asks if side == 'buy' else order_book.bids
    if not levels:
         return 0.0, 0.0

    volume_remaining_to_execute = volume
    cost_total = 0.0
    volume_executed = 0.0

    for price, available_volume in levels:
        if price is None or available_volume is None: continue
        try:
            price = float(price)
            available_volume = float(available_volume)
        except (ValueError, TypeError): continue # Пропускаем некорректные уровни
        if price <= 0 or available_volume <= 0: continue # Пропускаем некорректные уровни


        if volume_remaining_to_execute <= 1e-9: # Используем допуск
             break

        volume_to_take = min(volume_remaining_to_execute, available_volume)

        cost_total += volume_to_take * price
        volume_executed += volume_to_take
        volume_remaining_to_execute -= volume_to_take

    executed_price = cost_total / volume_executed if volume_executed > 1e-9 else 0.0 # Используем допуск
    # Возвращаем средневзвешенную цену и фактически исполненный объем (который может быть меньше желаемого)
    return executed_price, volume_executed


# НОВАЯ ФУНКЦИЯ ДЛЯ РАСЧЕТА ОПТИМАЛЬНОГО ОБЪЕМА И ПРИБЫЛИ С КОМИССИЯМИ
def find_executable_arbitrage_volume_and_profit(
    buy_ob: NormalizedOrderBook, # OB для покупки (asks)
    sell_ob: NormalizedOrderBook, # OB для продажи (bids)
    buy_exchange_id: str,
    sell_exchange_id: str,
    min_profit_pct: float, # Минимальная требуемая чистая прибыль в процентах
    max_volume_base_limit: float # Максимальный объем в базовой валюте, который мы готовы прогнать
) -> Tuple[float, float, float, float, float, float, float, float]:
    """
    Ищет оптимальный объем сделки в базовой валюте и рассчитывает чистую прибыль
    с учетом тейкерских комиссий, обеспечивая прибыль >= min_profit_pct.

    Алгоритм: Итеративно "проходит" по стаканам покупки (asks) и продажи (bids),
    накапливая объем и рассчитывая Gross и Net прибыль для каждой возможной порции.
    Находит точку, где Net прибыль (с учетом комиссий) максимальна ИЛИ где она падает
    ниже min_profit_pct. Возвращает метрики для максимального объема до этой точки
    (при условии, что max Net прибыль >= min_profit_pct).

    Args:
        buy_ob: Книга ордеров биржи, где покупаем (анализируем asks).
        sell_ob: Книга ордеров биржи, где продаем (анализируем bids).
        buy_exchange_id: ID биржи покупки (для получения комиссии).
        sell_exchange_id: ID биржи продажи (для получения комиссии).
        min_profit_pct: Минимальная требуемая чистая прибыль в процентах (например, 0.01).
        max_volume_base_limit: Максимальный объем в базовой валюте, который мы готовы рассмотреть.

    Returns:
        Кортеж: (
            executable_volume_base, # Максимальный объем базовой валюты, который можно прогнать
            buy_executed_price,     # Средняя цена покупки для этого объема
            sell_executed_price,    # Средняя цена продажи для этого объема
            gross_profit_pct,       # Gross прибыль (%) для этого объема
            net_profit_pct,         # Чистая прибыль (%) для этого объема
            fees_paid_quote,        # Общая комиссия (в цитируемой валюте) для этого объема
            cost_total_quote,       # Общая стоимость покупки (в цитируемой валюте) для этого объема
            revenue_total_quote     # Общая выручка от продажи (в цитируемой валюте) для этого объема
        ).
        Возвращает (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0) если возможность не найдена
        с прибылью >= min_profit_pct или ликвидности недостаточно.
    """
    # Проверка на наличие OB и уровней
    if not buy_ob or not buy_ob.asks or not sell_ob or not sell_ob.bids:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    # Проверка на наличие комиссий в конфигурации
    buy_taker_fee_pct = EXCHANGE_TAKER_FEES_PCT.get(buy_exchange_id, None)
    sell_taker_fee_pct = EXCHANGE_TAKER_FEES_PCT.get(sell_exchange_id, None)

    # Не можем рассчитать прибыль без комиссий для обеих сторон
    # TODO: Обработать случай, когда одной комиссии нет? Сейчас просто пропускаем
    if buy_taker_fee_pct is None or sell_taker_fee_pct is None:
        print(f"Warning: Commission not found for {buy_exchange_id} or {sell_exchange_id}. Cannot calculate Net Profit.")
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    # Комиссии в виде множителей: 1 - %/100
    buy_fee_multiplier = 1 - (buy_taker_fee_pct / 100.0)
    sell_fee_multiplier = 1 - (sell_taker_fee_pct / 100.0)

    # Индексы для итерации по уровням OB
    buy_level_idx = 0 # Идем по asks (покупаем)
    sell_level_idx = 0 # Идем по bids (продаем)

    # Накопленные метрики по мере прохождения по стаканам
    current_volume_base = 0.0
    current_cost_quote = 0.0 # Общая стоимость покупки в цитируемой валюте
    current_revenue_quote = 0.0 # Общая выручка от продажи в цитируемой валюте

    # Метрики лучшей найденной возможности (с максимальным Net Profit %)
    best_executable_volume_base = 0.0
    best_buy_executed_price = 0.0
    best_sell_executed_price = 0.0
    best_gross_profit_pct = 0.0
    best_net_profit_pct = -100.0 # Начинаем с очень низкого значения
    best_fees_paid_quote = 0.0
    best_cost_total_quote = 0.0
    best_revenue_total_quote = 0.0


    # Итерируемся по уровням стаканов, пока есть ликвидность на ОБЕИХ сторонах
    # и пока не превышен лимит максимального объема
    while (buy_level_idx < len(buy_ob.asks) and
           sell_level_idx < len(sell_ob.bids) and
           current_volume_base < max_volume_base_limit): # Учитываем лимит объема

        # Текущие уровни из стаканов
        # bids отсортированы по убыванию (лучшая цена первая)
        # asks отсортированы по возрастанию (лучшая цена первая)
        # При покупке мы берем Ask, при продаже мы берем Bid.
        # Арбитраж возможен, если лучшая цена продажи (Bid) > лучшей цены покупки (Ask) (до комиссий)
        # Иначе (sell_price <= buy_price), Gross прибыль будет <= 0
        # А Net прибыль (после комиссий) будет еще меньше.
        # Проверим это условие здесь, прежде чем что-либо считать
        current_buy_price_at_level = buy_ob.asks[buy_level_idx][0]
        current_sell_price_at_level = sell_ob.bids[sell_level_idx][0]

        # Оптимизация: если на текущих лучших уровнях цена продажи <= цене покупки,
        # то на последующих уровнях (ухудшающихся) спред будет только уменьшаться (или становиться более отрицательным).
        # Поэтому можно прекратить расчет для этого направления арбитража (Buy A -> Sell B).
        # Это проверка Gross спреда. Спред после комиссий (sell_price * sell_fee_multiplier > buy_price / buy_fee_multiplier)
        # является более точным критерием, но проверка gross спреда отсечет большинство неинтересных случаев быстро.
        # Однако, для алгоритма "нахождения оптимального объема", который может включать несколько уровней,
        # нужно пройти чуть глубже. Давайте проверим, падает ли Net прибыль ниже порога.
        # Будем двигаться по самому "узкому" стакану по объему.
        # Определяем объем, который можно взять на *текущих* уровнях
        buy_volume_at_level = buy_ob.asks[buy_level_idx][1]
        sell_volume_at_level = sell_ob.bids[sell_level_idx][1]

        # Объем, который можно прогнать на текущем шаге, ограничен ликвидностью текущих уровней
        # и оставшимся лимитом максимального объема.
        volume_to_process_step = min(buy_volume_at_level, sell_volume_at_level, max_volume_base_limit - current_volume_base)

        # Если объем на текущем шаге меньше или равен нулю (с учетом погрешности), переходим к следующим уровням
        if volume_to_process_step <= 1e-9:
             # Если buy_volume_at_level <= sell_volume_at_level, значит исчерпан buy_level_idx, двигаем его.
             # Если sell_volume_at_level < buy_volume_at_level, значит исчерпан sell_level_idx, двигаем его.
             # Если оба <= 1e-9 (один из них был 0), двигаем оба.
             # Если volume_to_process_step == max_volume_base_limit - current_volume_base, значит достигнут лимит, выходим.
             # Упрощенно: двигаем индекс того уровня, чей объем был минимальным.
             if math.isclose(volume_to_process_step, max_volume_base_limit - current_volume_base, rel_tol=1e-9):
                  break # Достигнут лимит объема
             elif buy_volume_at_level <= sell_volume_at_level: # Двигаем buy_level_idx, если buy_level был узким местом
                 buy_level_idx += 1
                 continue # Переходим к следующей итерации цикла
             else: # Двигаем sell_level_idx
                 sell_level_idx += 1
                 continue # Переходим к следующей итерации цикла


        # Цены на текущих уровнях для шага
        price_buy_step = buy_ob.asks[buy_level_idx][0]
        price_sell_step = sell_ob.bids[sell_level_idx][0]

        # Рассчитываем стоимость и выручку для объема шага
        cost_step_quote = volume_to_process_step * price_buy_step
        revenue_step_quote = volume_to_process_step * price_sell_step

        # Накапливаем общую стоимость, выручку и объем
        current_cost_quote += cost_step_quote
        current_revenue_quote += revenue_step_quote
        current_volume_base += volume_to_process_step

        # Рассчитываем средние исполненные цены для ТЕКУЩЕГО НАКОПЛЕННОГО объема
        # (средневзвешенные цены до текущего шага включительно)
        current_buy_executed_price = current_cost_quote / current_volume_base if current_volume_base > 1e-9 else 0.0
        current_sell_executed_price = current_revenue_quote / current_volume_base if current_volume_base > 1e-9 else 0.0

        # Рассчитываем Gross прибыль (%) для ТЕКУЩЕГО НАКОПЛЕННОГО объема
        current_gross_profit_pct = ((current_sell_executed_price / current_buy_executed_price) - 1) * 100 if current_buy_executed_price > 1e-9 else -100.0

        # Рассчитываем Net прибыль (%) с учетом тейкерских комиссий для ТЕКУЩЕГО НАКОПЛЕННОГО объема
        # Комиссия при покупке: buy_taker_fee_pct % от current_cost_quote
        # Комиссия при продаже: sell_taker_fee_pct % от current_revenue_quote (или от current_revenue_quote * sell_fee_multiplier?)
        # Обычно комиссия берется от суммы сделки. При покупке за Quote, комиссия берется от Quote. При продаже Base за Quote, комиссия берется от полученного Quote.
        # Упрощенно: комиссии - это процент от общей стоимости покупки и от общей выручки продажи.
        fees_buy_quote = current_cost_quote * (buy_taker_fee_pct / 100.0)
        fees_sell_quote = current_revenue_quote * (sell_taker_fee_pct / 100.0) # Или от (current_revenue_quote - fees_buy_quote)? Упрощаем.
        total_fees_quote = fees_buy_quote + fees_sell_quote


        # Чистая выручка (в Quote) после всех комиссий
        net_revenue_quote = current_revenue_quote - total_fees_quote

        # Чистая прибыль (в Quote)
        current_net_profit_quote = net_revenue_quote - current_cost_quote

        # Чистая прибыль (%)
        # Рассчитываем как (Чистая выручка - Стоимость) / Стоимость * 100
        current_net_profit_pct = (current_net_profit_quote / current_cost_quote) * 100 if current_cost_quote > 1e-9 else -100.0

        # --- Проверяем, является ли текущая Net прибыль лучшей найденной до сих пор ---
        # Ищем точку, где Net прибыль максимальна ИЛИ где она впервые падает ниже min_profit_pct
        # Если текущая Net прибыль выше лучшей найденной ИЛИ текущая Net прибыль > min_profit_pct
        # (даже если она ниже предыдущей, но все еще выше порога, мы можем хотеть обновить best?)
        # Давайте найдем *максимальную* Net прибыль, которая >= min_profit_pct.
        # Если текущая Net прибыль >= min_profit_pct, обновляем best, если она выше предыдущего best_net_profit_pct
        # ИЛИ если это первая найденная возможность >= min_profit_pct.
        if current_net_profit_pct >= min_profit_pct:
             if current_net_profit_pct > best_net_profit_pct:
                 best_executable_volume_base = current_volume_base
                 best_buy_executed_price = current_buy_executed_price
                 best_sell_executed_price = current_sell_executed_price
                 best_gross_profit_pct = current_gross_profit_pct
                 best_net_profit_pct = current_net_profit_pct
                 best_fees_paid_quote = total_fees_quote
                 best_cost_total_quote = current_cost_quote
                 best_revenue_total_quote = current_revenue_quote
                 # print(f"Found better Net Profit: {best_net_profit_pct:.4f}% at Vol: {best_executable_volume_base:.8f}") # Отладка
        else:
             # Если текущая Net прибыль упала ниже порога, дальше двигаться нет смысла
             # (цены будут только ухудшаться). Завершаем итерацию.
             # print(f"Net Profit dropped below threshold {min_profit_pct}% at Vol: {current_volume_base:.8f}. Stopping.") # Отладка
             break # Выходим из цикла

        # Уменьшаем объем на текущих уровнях на volume_to_process_step
        # buy_ob.asks[buy_level_idx] = (price_buy_step, buy_volume_at_level - volume_to_process_step) # Нельзя менять исходные данные
        # sell_ob.bids[sell_level_idx] = (price_sell_step, sell_volume_at_level - volume_to_process_step)

        # Двигаем индекс уровня, чей объем был исчерпан на этом шаге
        if math.isclose(volume_to_process_step, buy_volume_at_level, rel_tol=1e-9):
            buy_level_idx += 1 # Исчерпан ask
        if math.isclose(volume_to_process_step, sell_volume_at_level, rel_tol=1e-9):
             # Важно: если оба объема были равны, двигаем оба индекса
             sell_level_idx += 1 # Исчерпан bid


    # Возвращаем метрики лучшей возможности, найденной в процессе итерации,
    # при условии, что ее Net прибыль >= min_profit_pct
    if best_net_profit_pct >= min_profit_pct and best_executable_volume_base > 1e-9:
        # print(f"Returning best opportunity: Net Profit {best_net_profit_pct:.4f}% at Vol {best_executable_volume_base:.8f}") # Отладка
        return (
            best_executable_volume_base,
            best_buy_executed_price,
            best_sell_executed_price,
            best_gross_profit_pct,
            best_net_profit_pct,
            best_fees_paid_quote,
            best_cost_total_quote, # Можем вернуть и эти для полноты, если нужны
            best_revenue_total_quote
        )
    else:
        # print(f"No opportunity found with Net Profit >= {min_profit_pct}%.") # Отладка
        # Если лучшая прибыль ниже порога или не удалось набрать объем, возвращаем нули
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 # Нет подходящей возможности


# TODO: Реализовать учет комиссий за вывод/перевод в этой функции,
# если бэкенд будет предоставлять нужные данные о сетях и комиссиях.
# Это сложный расчет, т.к. комиссия вывода фиксирована, а не процент, и зависит от сети.





