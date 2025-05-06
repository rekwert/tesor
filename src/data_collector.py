import asyncio
import ccxt.async_support as ccxt
import os
from dotenv import load_dotenv
import pprint # Для красивого вывода словарей/списков
from typing import Dict, Any, List, Tuple

# Импортируем наши Pydantic модели
from models import NormalizedTicker, NormalizedOrderBook, ArbitrageOpportunity # Добавил ArbitrageOpportunity, хотя пока не используем

# Импортируем базовый класс исключений из ccxt и конкретные ошибки
from ccxt.base.errors import BaseError, BadSymbol, ExchangeError, RequestTimeout, NetworkError

# --- Конфигурация (пока хардкод, позже загрузим из БД/конфига) ---
# Загрузка переменных окружения
load_dotenv()

# Список бирж для отслеживания (используем lowercase ID из ccxt)
# Изменили 'coinbasepro' на 'coinbase'
EXCHANGES_TO_TRACK = ['binance', 'coinbase', 'kraken']

# Список пар для отслеживания (используем стандартизированный формат 'BASE/QUOTE')
PAIRS_TO_TRACK = ['BTC/USDT', 'ETH/USDT', 'LTC/USDT'] # Добавил LTC/USDT для примера

# Глубина книги ордеров, которую запрашиваем
ORDER_BOOK_DEPTH = 20 # Увеличим до 20 лучших предложений

# --- Хранилище актуальных нормализованных данных (в памяти) ---
# Структура: { exchange_id: { symbol: NormalizedTicker | NormalizedOrderBook } }
# Используем Dict[str, Dict[str, Any]] т.к. значения могут быть разных типов моделей
current_market_data: Dict[str, Dict[str, Any]] = {}

# --- Вспомогательная функция для нормализации ---
# Эти функции остаются такими же, как мы их определили ранее в Шаге 3
def normalize_ccxt_ticker(exchange_id: str, symbol: str, ticker_data: Dict[str, Any]) -> NormalizedTicker | None:
    """Нормализует сырые данные тикера из ccxt в Pydantic модель."""
    if not ticker_data:
        return None
    try:
        return NormalizedTicker(
            exchange=exchange_id,
            symbol=symbol,
            bid=ticker_data.get('bid'),
            ask=ticker_data.get('ask'),
            last=ticker_data.get('last'),
            timestamp=ticker_data.get('timestamp'), # timestamp в ms
            datetime=ticker_data.get('datetime')
        )
    except Exception as e:
        print(f"Ошибка нормализации тикера для {symbol}@{exchange_id}: {e}")
        return None

def normalize_ccxt_order_book(exchange_id: str, symbol: str, order_book_data: Dict[str, Any]) -> NormalizedOrderBook | None:
    """Нормализует сырые данные книги ордеров из ccxt в Pydantic модель."""
    if not order_book_data:
        return None
    try:
        bids_raw = order_book_data.get('bids', [])
        asks_raw = order_book_data.get('asks', [])

        # --- Специальная обработка для Kraken ---
        # Kraken иногда возвращает книгу ордеров с 3 элементами в каждом list/tuple: [price, volume, timestamp]
        # Нам для Pydantic модели NormalizedOrderBook нужны только [price, volume].
        # Проверяем, если список bids/asks не пустой и первый элемент имеет 3 элемента
        if exchange_id == 'kraken':
            if bids_raw and len(bids_raw[0]) > 2:
                # Обрезаем каждый элемент до первых двух
                bids_processed = [[float(item[0]), float(item[1])] for item in bids_raw]
            else:
                 bids_processed = [[float(item[0]), float(item[1])] for item in bids_raw] # Просто приводим к float на всякий случай
            if asks_raw and len(asks_raw[0]) > 2:
                asks_processed = [[float(item[0]), float(item[1])] for item in asks_raw]
            else:
                 asks_processed = [[float(item[0]), float(item[1])] for item in asks_raw] # Просто приводим к float
        else:
            # Для других бирж ожидаем стандартный формат [price, volume]
             bids_processed = [[float(item[0]), float(item[1])] for item in bids_raw] if bids_raw else []
             asks_processed = [[float(item[0]), float(item[1])] for item in asks_raw] if asks_raw else []


        return NormalizedOrderBook(
            exchange=exchange_id,
            symbol=symbol,
            bids=bids_processed, # Используем обработанные списки
            asks=asks_processed, # Используем обработанные списки
            timestamp=order_book_data.get('timestamp'), # timestamp в ms
            datetime=order_book_data.get('datetime')
        )
    except Exception as e:
        # Выведем сырые данные, если нормализация не удалась, чтобы понять причину
        print(f"Ошибка нормализации книги ордеров для {symbol}@{exchange_id}: {e}")
        # print("Сырые данные книги ордеров:")
        # pprint.pprint(order_book_data) # Раскомментируй для отладки формата данных
        return None

# --- Функция сбора данных для ОДНОЙ пары на ОДНОЙ бирже ---
async def fetch_pair_data(exchange_id: str, symbol: str):
    """
    Получает тикер и книгу ордеров для одной пары на одной бирже,
    нормализует и обновляет глобальное хранилище.
    """
    exchange = None
    try:
        exchange_class = getattr(ccxt, exchange_id)
        # Приватные ключи тут не нужны. enableRateLimit очень важен!
        exchange = exchange_class({'enableRateLimit': True})

        # NOTE: load_markets() часто нужен для fetch_ticker/fetch_order_book
        # чтобы ccxt мог корректно маппить символы биржи и проверить их наличие.
        # Вызывать его для каждой пары неэффективно. В более сложной версии
        # мы бы загружали рынки один раз для каждого экземпляра биржи при старте
        # или перед первым использованием. Для простоты MVP и быстрого старта,
        # ccxt часто сам вызывает load_markets() внутри fetch_ticker/fetch_order_book
        # если рынки еще не загружены. Это может увеличить задержку первого запроса,
        # но упрощает код сейчас.
        # await exchange.load_markets() # Закомментировано для упрощения MVP

        # Получаем тикер
        ticker_data = await exchange.fetch_ticker(symbol)
        normalized_ticker = normalize_ccxt_ticker(exchange_id, symbol, ticker_data)
        if normalized_ticker:
            # Обновляем глобальное хранилище
            # Проверка и инициализация вложенных словарей
            if exchange_id not in current_market_data:
                current_market_data[exchange_id] = {}
            current_market_data[exchange_id][symbol] = normalized_ticker
            # print(f"Обновлен тикер для {symbol}@{exchange_id}") # Можно закомментировать для уменьшения вывода

        # Получаем книгу ордеров
        order_book_data = await exchange.fetch_order_book(symbol, limit=ORDER_BOOK_DEPTH)
        normalized_order_book = normalize_ccxt_order_book(exchange_id, symbol, order_book_data)
        if normalized_order_book:
            # Обновляем глобальное хранилище
            if exchange_id not in current_market_data:
                current_market_data[exchange_id] = {}
            # Добавляем суффикс _ob, чтобы отличать книгу ордеров от тикера для той же пары
            current_market_data[exchange_id][f"{symbol}_ob"] = normalized_order_book
            # print(f"Обновлена книга ордеров для {symbol}@{exchange_id}") # Можно закомментировать для уменьшения вывода

    # --- Исправленные блоки except ---
    # Ловим специфические ошибки ccxt
    except BadSymbol: # Ошибка: указан неверный символ или пара неактивна на бирже
         print(f"Пара {symbol} не поддерживается биржей {exchange_id}.")
    except ExchangeError as e: # Ошибка, возвращенная биржей
        print(f"Ошибка биржи {exchange_id} при получении данных для {symbol}: {e}")
    except RequestTimeout as e: # Ошибка таймаута при запросе
         print(f"Таймаут запроса к {exchange_id} для {symbol}: {e}")
    except NetworkError as e: # Сетевая ошибка (например, проблема с соединением)
        print(f"Сетевая ошибка при работе с {exchange_id} для {symbol}: {e}")
    except BaseError as e: # Ловим любые другие ошибки, наследующие от BaseError
         print(f"Общая ошибка CCXT при работе с {exchange_id} для {symbol}: {e}")
    except Exception as e:
        # Ловим любые другие неожиданные ошибки Python
        print(f"Произошла неожиданная ошибка при работе с {exchange_id} для {symbol}: {e}")
    finally:
        # Обязательно закрываем асинхронное соединение
        if exchange:
            await exchange.close()


# --- Функция, запускающая сбор данных для всех бирж и пар ---
async def collect_all_market_data():
    """
    Запускает параллельный сбор данных для всех сконфигурированных бирж и пар.
    Работает в бесконечном цикле.
    """
    while True:
        print("\nНачинаем новый цикл сбора данных...")
        tasks = []
        for exchange_id in EXCHANGES_TO_TRACK:
            for symbol in PAIRS_TO_TRACK:
                # Создаем асинхронную задачу для каждой пары на каждой бирже
                tasks.append(asyncio.create_task(fetch_pair_data(exchange_id, symbol)))

        # Ждем завершения всех задач сбора данных в текущем цикле.
        # return_exceptions=True гарантирует, что gather соберет все результаты/исключения
        # и не остановится при первой ошибке.
        results = await asyncio.gather(*tasks, return_exceptions=True)

        print("Цикл сбора данных завершен.")

        # --- Здесь, после сбора данных, мы бы запускали поиск арбитража (Следующий Шаг) ---
        # Например:
        # opportunities = find_arbitrage_opportunities(current_market_data)
        # if opportunities:
        #     print(f"Найдены {len(opportunities)} арбитражные возможности:")
        #     for opp in opportunities:
        #         print(f"  {opp.symbol}: Buy on {opp.buy_exchange} @ {opp.buy_price}, Sell on {opp.sell_exchange} @ {opp.sell_price} -> Profit: {opp.potential_profit_pct:.4f}%")


        # Пример вывода части собранных данных для проверки
        print("\nПример актуальных данных в памяти:")
        # Выведем тикеры для BTC/USDT и ETH/USDT с каждой биржи, если они есть
        for symbol_to_display in ['BTC/USDT', 'ETH/USDT']:
             for exchange_id in EXCHANGES_TO_TRACK:
                 ticker_key = symbol_to_display
                 # Проверяем наличие exchange_id и symbol в словаре перед доступом
                 if exchange_id in current_market_data and ticker_key in current_market_data[exchange_id]:
                     # Убедимся, что это NormalizedTicker
                     data_item = current_market_data[exchange_id][ticker_key]
                     if isinstance(data_item, NormalizedTicker):
                        print(f"  {exchange_id.upper():<12} - {ticker_key:<10}: Bid={data_item.bid:<15}, Ask={data_item.ask}") # Форматируем для красивого вывода
                     else:
                         print(f"  Найдены данные другого типа для {ticker_key} на {exchange_id.upper()}.")
                 else:
                      print(f"  Данные для {ticker_key} на {exchange_id.upper():<12} пока отсутствуют (или ошибка).")


        # Небольшая пауза перед следующим циклом сбора (важно для REST API)
        # В будущем будем использовать WebSockets для мгновенных обновлений и более гибкой логики
        await asyncio.sleep(5) # Пауза 5 секунд


# Основная точка входа
async def main():
    """Основная функция приложения."""
    print("Запуск коллектора данных...")
    # Запускаем бесконечный цикл сбора данных как фоновую задачу
    collector_task = asyncio.create_task(collect_all_market_data())

    print("Коллектор запущен. Нажмите Ctrl+C для остановки.")
    try:
        # Ждем завершения задачи. Поскольку collect_all_market_data в бесконечном цикле,
        # await collector_task будет ждать бесконечно, пока задача не будет отменена (например, по Ctrl+C)
        await collector_task
    except asyncio.CancelledError:
        print("Коллектор задача отменена.")
    # Дополнительная обработка исключений, если main() должна их ловить


# Запуск основной асинхронной функции при выполнении скрипта
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # Перехватываем Ctrl+C для graceful завершения
        print("\nПолучен сигнал остановки (Ctrl+C). Завершение работы.")
        # asyncio.run() должен корректно завершить задачи при KeyboardInterrupt
    # Здесь не нужно вызывать asyncio.run() еще раз, он уже был вызван.
    # Все необработанные исключения из main() или collector_task
    # будут показаны asyncio.run() перед завершением.