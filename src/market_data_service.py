import asyncio
import ccxt.pro as ccxtpro
import time
import json
import logging
from typing import Dict, Any, List, Tuple, Set, Optional, Union

# Импортируем модели, утилиты и конфигурацию
from src.data_models import NormalizedTicker, NormalizedOrderBook, ArbitrageOpportunity
from src.arbitrage_scanner import find_arbitrage_opportunities_with_order_book
from src.config import (
    EXCHANGES_TO_TRACK_WS, PAIRS_TO_TRACK_WS, WS_ORDER_BOOK_DEPTH,
    MIN_PROFIT_PCT, SCANNER_INTERVAL_SECONDS, DESIRED_TRADE_VOLUME_BASE
)

from ccxt.base.errors import (
    BaseError, BadSymbol, ExchangeError, RequestTimeout, NetworkError,
    AuthenticationError, OperationRejected, ArgumentsRequired, NotSupported
)
import traceback # Импортируем traceback для более подробных логов ошибок

# Настройка логирования
# Уровень логирования можно настроить в основном файле запуска или через env переменные
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Вспомогательные функции нормализации (если они не в utils.py) ---
# Если normalize_ccxt_ticker и normalize_ccxt_order_book определены в src/utils.py,
# убедитесь, что они импортированы. Если нет, вот их примерная реализация
# на основе парсеров ccxt.pro, адаптированная для создания Pydantic моделей:

# def normalize_ccxt_ticker(exchange_id: str, symbol: str, raw_ticker: dict) -> Optional[NormalizedTicker]:
#     """Нормализует сырые данные тикера от ccxt.pro в модель NormalizedTicker."""
#     if not raw_ticker or not isinstance(raw_ticker, dict):
#         logger.warning(f"Normalization error for {symbol}@{exchange_id}: raw_ticker is not a dict.")
#         return None
#     try:
#         # ccxt.pro parse_ticker возвращает dict с ключами 'symbol', 'bid', 'ask', 'last', 'timestamp', 'datetime', etc.
#         # Проверяем типы основных полей перед созданием модели
#         bid = raw_ticker.get('bid')
#         ask = raw_ticker.get('ask')
#         last = raw_ticker.get('last')
#
#         if (bid is not None and not isinstance(bid, (int, float))) or \
#            (ask is not None and not isinstance(ask, (int, float))) or \
#            (last is not None and not isinstance(last, (int, float))):
#             logger.warning(f"Normalization error for {symbol}@{exchange_id}: bid/ask/last are not numbers or None. Data: {raw_ticker}")
#             return None
#
#         return NormalizedTicker(
#             exchange=exchange_id,
#             symbol=raw_ticker.get('symbol', symbol), # Используем символ из данных, если есть, иначе из аргументов
#             bid=bid,
#             ask=ask,
#             last=last,
#             timestamp=raw_ticker.get('timestamp'),
#             datetime=raw_ticker.get('datetime'),
#             # Добавьте другие поля тикера, если нужны в модели
#         )
#     except Exception as e:
#         logger.error(f"Normalization error creating NormalizedTicker for {symbol}@{exchange_id}: {e}. Data: {raw_ticker}", exc_info=True)
#         return None

# def normalize_ccxt_order_book(exchange_id: str, symbol: str, raw_order_book: dict) -> Optional[NormalizedOrderBook]:
#     """Нормализует сырые данные книги ордеров от ccxt.pro в модель NormalizedOrderBook."""
#     if not raw_order_book or not isinstance(raw_order_book, dict):
#          logger.warning(f"Normalization error for {symbol}@{exchange_id}: raw_order_book is not a dict.")
#          return None
#
#     bids = raw_order_book.get('bids', [])
#     asks = raw_order_book.get('asks', [])
#
#     # Проверка, что bids и asks - списки списков с числами (опционально, но полезно)
#     def is_valid_level(level):
#          return isinstance(level, list) and len(level) >= 2 and \
#                 isinstance(level[0], (int, float)) and isinstance(level[1], (int, float))
#
#     if not isinstance(bids, list) or not all(is_valid_level(level) for level in bids):
#          logger.warning(f"Normalization warning for {symbol}@{exchange_id}: bids are not valid. Data: {raw_order_book}")
#          bids = [] # Очищаем некорректные данные
#     if not isinstance(asks, list) or not all(is_valid_level(level) for level in asks):
#          logger.warning(f"Normalization warning for {symbol}@{exchange_id}: asks are not valid. Data: {raw_order_book}")
#          asks = [] # Очищаем некорректные данные
#
#     try:
#         return NormalizedOrderBook(
#             exchange=exchange_id,
#             symbol=raw_order_book.get('symbol', symbol),
#             bids=bids,
#             asks=asks,
#             timestamp=raw_order_book.get('timestamp'),
#             datetime=raw_order_book.get('datetime'),
#         )
#     except Exception as e:
#         logger.error(f"Normalization error creating NormalizedOrderBook for {symbol}@{exchange_id}: {e}. Data: {raw_order_book}", exc_info=True)
#         return None

# --- Конец вспомогательных функций нормализации ---


class MarketDataService:
    """
    Сервис для сбора данных рынка по WebSocket, их хранения и запуска сканера арбитража.
    Управляет подключениями к биржам, обработкой данных и рассылкой возможностей по WS.
    """
    def __init__(self):
        # current_market_data хранит последние данные с бирж по всем отслеживаемым парам.
        # Структура: { exchange_id: { symbol: NormalizedTicker, symbol+'_ob': NormalizedOrderBook, ... }, ... }
        # Доступ к этому словарю должен быть синхронизирован с _data_lock.
        self.current_market_data: Dict[str, Dict[str, Union[NormalizedTicker, NormalizedOrderBook]]] = {}

        # latest_opportunities хранит список последних найденных арбитражных возможностей.
        # Этот список уже отфильтрован сканером по MIN_PROFIT_PCT и отсортирован.
        # Доступ к этому списку также требует синхронизации, хотя в текущей реализации
        # он только читается извне (get_latest_opportunities) и перезаписывается сканером.
        # Для простоты, get_latest_opportunities возвращает копию без захвата лока,
        # что безопасно для чтения, но не для модификации. Сканер модифицирует его под своим контролем.
        self.latest_opportunities: List[ArbitrageOpportunity] = []

        # Флаг для управления циклом работы сервиса
        self._running = False

        # Список задач (task) asyncio для отслеживания данных с бирж
        self._collector_tasks: List[asyncio.Task] = []
        # Задача (task) asyncio для запуска сканера арбитража
        self._scanner_task: asyncio.Task | None = None

        # asyncio.Lock для синхронизации доступа к current_market_data и _exchange_status
        self._data_lock = asyncio.Lock()

        # Множество очередей активных WebSocket подписчиков
        self.active_ws_connections: Set[asyncio.Queue] = set()

        # --- Состояние подключения бирж ---
        # Словарь: { exchange_id: статус }
        # Статусы: 'connecting', 'connected', 'disconnected', 'error', 'auth_error', 'no_ws_support', 'no_pairs'
        # Доступ к этому словарю должен быть синхронизирован с _data_lock.
        self._exchange_status: Dict[str, str] = {}


    async def start(self):
        """
        Запускает задачи сбора данных с бирж и задачу сканера арбитража.
        Этот метод вызывается при запуске FastAPI приложения.
        """
        if self._running:
            logger.info("MarketDataService уже запущен.")
            return

        logger.info("Запуск MarketDataService...")
        self._running = True

        # Инициализируем статус бирж перед запуском задач
        async with self._data_lock:
             for exchange_id in EXCHANGES_TO_TRACK_WS:
                  # Устанавливаем начальный статус 'disconnected' для всех настроенных бирж
                  self._exchange_status[exchange_id] = 'disconnected'

        # Запускаем отдельную асинхронную задачу для подключения к каждой бирже
        for exchange_id in EXCHANGES_TO_TRACK_WS:
            task = asyncio.create_task(self._watch_exchange(exchange_id))
            self._collector_tasks.append(task)
            logger.debug(f"Создана задача _watch_exchange для биржи {exchange_id.upper()}")

        logger.info(f"Задачи подключения к {len(self._collector_tasks)} WebSocket биржам запущены.")

        # Запускаем задачу периодического сканера арбитража
        self._scanner_task = asyncio.create_task(self._run_arbitrage_scanner())
        logger.info("Задача поиска арбитража запущена.")


    async def stop(self):
        """
        Останавливает задачи сбора данных с бирж и задачу сканера арбитража.
        Этот метод вызывается при остановке FastAPI приложения.
        """
        if not self._running:
            logger.info("MarketDataService не запущен.")
            return

        logger.info("Остановка MarketDataService...")
        self._running = False # Устанавливаем флаг, чтобы циклы завершились

        # --- Отменяем задачи коллектора ---
        logger.info("Отмена задач коллектора...")
        for task in self._collector_tasks:
            #logger.debug(f"Отмена задачи: {task}")
            task.cancel() # Отправляем сигнал отмены задаче
        # Ожидаем завершения всех задач коллектора. return_exceptions=True
        # предотвращает остановку gather, если одна из задач завершится с ошибкой,
        # но не с CancelledError.
        results = await asyncio.gather(*self._collector_tasks, return_exceptions=True)
        self._collector_tasks = []
        logger.info("Задачи коллектора отменены.")
        # Можно проанализировать results на ошибки, если нужно

        # --- Отменяем задачу сканера ---
        logger.info("Отмена задачи сканера...")
        if self._scanner_task and not self._scanner_task.done():
             self._scanner_task.cancel() # Отправляем сигнал отмены задаче сканера
             try:
                 # Ожидаем завершения задачи сканера. Если она правильно обрабатывает
                 # CancelledError, она завершится. Если нет - может пробросить ошибку.
                 await self._scanner_task
                 logger.info("Задача сканера отменена и завершена.")
             except asyncio.CancelledError:
                 logger.info("Задача сканера отменена.")
             except Exception as e:
                 # Ловим любые другие ошибки, возникшие при отмене или завершении задачи
                 logger.error(f"Ошибка при остановке задачи сканера: {e}", exc_info=True)
             self._scanner_task = None
        else:
             logger.info("Задача сканера уже завершена или отсутствует.")


        # --- Уведомляем WS подписчиков о завершении работы ---
        if self.active_ws_connections:
            logger.info(f"Отправка сигнала остановки {len(self.active_ws_connections)} WS подписчикам...")
            # Используем копию множества, т.к. unsubscribe_ws может изменить оригинал
            subscribers_to_notify = list(self.active_ws_connections)
            for queue in subscribers_to_notify:
                 try:
                      # Отправляем специальный сигнал (например, None) в очередь подписчика
                      # Это позволит его циклу чтения `await queue.get()` завершиться.
                     await queue.put(None)
                 except Exception:
                     # Игнорируем ошибки, если очередь уже закрыта или некорректна
                     pass
            # Даем небольшое время на обработку сигнала остановки, прежде чем очистить множество
            await asyncio.sleep(0.1)
            self.active_ws_connections.clear()
            logger.info("Множество WS подписчиков очищено.")


        # --- Очищаем данные и сбрасываем статусы бирж при остановке сервиса ---
        # Доступ к разделяемому состоянию под локом
        async with self._data_lock:
             # Очищаем все собранные рыночные данные
             self.current_market_data.clear()
             logger.info("Хранилище market_data очищено.")

             # Сбрасываем статусы бирж. Для статусов auth_error, no_ws_support, no_pairs
             # оставляем их как есть, т.к. это постоянные ошибки конфигурации/поддержки.
             # Для остальных статусов (connected, connecting, error, disconnected) сбрасываем на disconnected.
             exchanges_to_reset_status = [
                 ex_id for ex_id, status in self._exchange_status.items()
                 if status not in ['auth_error', 'no_ws_support', 'no_pairs']
             ]
             for ex_id in exchanges_to_reset_status:
                  self._exchange_status[ex_id] = 'disconnected'
             logger.info("Статусы бирж сброшены на 'disconnected'.")


        logger.info("MarketDataService остановлен.")


    def get_latest_opportunities(self) -> List[ArbitrageOpportunity]:
        """
        Возвращает список последних найденных арбитражных возможностей.
        Этот метод синхронный. Используется для REST API эндпоинтов.
        Возвращает копию списка latest_opportunities, который обновляется сканером.
        """
        # Возвращаем копию списка, чтобы избежать внешних модификаций
        # В текущей логике сканер перезаписывает весь список, поэтому чтение копии безопасно.
        return self.latest_opportunities[:]


    async def subscribe_ws(self) -> asyncio.Queue:
        """
        Добавляет нового WebSocket подписчика.
        Возвращает асинхронную очередь (Queue) для отправки сообщений подписчику.
        Отправляет текущий список возможностей сразу при подключении.
        """
        # Создаем новую очередь для этого подписчика
        queue = asyncio.Queue()
        # Добавляем очередь в множество активных соединений
        self.active_ws_connections.add(queue)
        logger.info(f"Новый WS подписчик добавлен. Всего: {len(self.active_ws_connections)}")

        # Отправляем новому подписчику текущий список возможностей сразу при подключении
        # latest_opportunities уже содержит отфильтрованные и отсортированные данные из последнего сканирования
        if self.latest_opportunities:
             try:
                 # Сериализуем список возможностей в JSON строку. model_dump() корректно обрабатывает Pydantic модели.
                 message = json.dumps([opp.model_dump() for opp in self.latest_opportunities])
                 # Помещаем сообщение в очередь подписчика. put_nowait может вызвать QueueFull,
                 # но при первой отправке очередь пуста, поэтому маловероятно.
                 # Используем await put, чтобы убедиться, что сообщение помещено.
                 await queue.put(message)
                 logger.debug(f"Отправлены текущие возможности новому подписчику {queue} ({len(self.latest_opportunities)} шт).")
             except Exception as e:
                  # Логируем ошибку, но не считаем ее критичной для сервиса, просто для этого подписчика.
                  logger.error(f"Ошибка при отправке текущих возможностей новому подписчику {queue}: {e}", exc_info=True)

        # Возвращаем очередь, которую будет читать эндпоинт WS
        return queue

    async def unsubscribe_ws(self, queue: asyncio.Queue):
        """
        Удаляет WebSocket подписчика.
        Удаляет очередь подписчика из множества активных соединений.
        """
        if queue in self.active_ws_connections:
            self.active_ws_connections.remove(queue)
            logger.info(f"WS подписчик удален. Всего: {len(self.active_ws_connections)}")
            # Очередь подписчика может быть закрыта или помечена для завершения
            # в логике эндпоинта, который ее читает (ws_endpoints.py)


    async def _notify_ws_subscribers(self, opportunities: List[ArbitrageOpportunity]):
        """
        Отправляет список найденных возможностей всем активным WebSocket подписчикам.
        Этот список уже отфильтрован сканером по MIN_PROFIT_PCT и отсортирован.
        """
        # Мы отправляем список, даже если он пуст (0 возможностей >= MIN_PROFIT_PCT).
        # Это позволяет фронтенду очистить таблицу, если прибыльных возможностей временно нет.
        try:
             # Сериализуем список возможностей в JSON строку
             message = json.dumps([opp.model_dump() for opp in opportunities])
             # print(f"Отправка WS сообщения: {len(message)} байт, {len(opportunities)} возможностей") # Отладка

        except Exception as e:
             # Ошибка сериализации - это проблема, но не останавливает сервис
             logger.error(f"Ошибка при сериализации возможностей в JSON для WS: {e}", exc_info=True)
             return # Не можем отправить некорректное сообщение

        # Отправляем сообщение в очереди всех активных подписчиков
        # Используем list() копию множества, т.к. remove может быть вызвана внутри цикла
        # из-за ошибки QueueFull или другой ошибки отправки.
        subscribers_to_notify = list(self.active_ws_connections)
        if not subscribers_to_notify:
            # logger.debug("Нет активных WS подписчиков для уведомления.")
            return

        #logger.debug(f"Уведомление {len(subscribers_to_notify)} WS подписчиков...")
        for queue in subscribers_to_notify:
            try:
                # Используем put_nowait для неблокирующей отправки.
                # Если очередь полна (подписчик медленный), это вызовет asyncio.QueueFull.
                queue.put_nowait(message)
                # logger.debug(f"Сообщение поставлено в очередь подписчика {queue}.")
            except asyncio.QueueFull:
                 # Если очередь полна, логируем предупреждение и, возможно,
                 # отключаем этого подписчика в будущем, чтобы не тратить ресурсы.
                 # Пока просто пропускаем отправку для него в этом цикле.
                 logger.warning(f"Ошибка: Очередь подписчика {queue} заполнена. Пропускаем сообщение для него.")
                 # TODO: Реализовать логику отключения медленных клиентов.
            except Exception as e:
                # Ловим любые другие ошибки при работе с очередью (например, очередь закрыта)
                logger.error(f"Не удалось поставить сообщение в очередь подписчика {queue}: {e}. Отписка.", exc_info=True)
                # Отписываем клиента при ошибке отправки в его очередь
                # Запускаем отписку в отдельной задаче, чтобы не блокировать цикл отправки для других подписчиков.
                asyncio.create_task(self.unsubscribe_ws(queue))


    # --- Приватные методы для внутренних задач ( watch_exchange, watch_order_book, watch_ticker ) ---

    async def _watch_exchange(self, exchange_id: str):
        """
        Подключается к конкретной бирже по WebSocket, управляет подписками на OB/Ticker.
        Обрабатывает ошибки подключения и переподключения для всей биржи.
        """
        exchange = None # Объект биржи ccxtpro
        reconnect_delay = 1 # Начальная задержка перед переподключением (в секундах)
        MAX_RECONNECT_DELAY = 60 # Максимальная задержка перед переподключением (в секундах)

        # Внешний цикл для обработки критических ошибок и переподключений всей биржи
        while self._running:
            try:
                logger.info(f"Attempting to connect to {exchange_id.upper()} WebSocket...")
                # Обновляем статус подключения под локом
                async with self._data_lock:
                     self._exchange_status[exchange_id] = 'connecting'

                # --- Инициализация биржи ---
                # Получаем класс биржи из ccxtpro по ее ID
                exchange_class = getattr(ccxtpro, exchange_id)
                # Создаем экземпляр биржи
                # TODO: Добавить API ключи и секреты сюда, если они нужны для WS (например, приватные подписки)
                # или для REST запросов (load_markets, fetch_fees, fetch_deposit_withdraw_fees).
                # Не храните ключи здесь в открытом виде! Используйте переменные окружения.
                # exchange = exchange_class({
                #     'apiKey': os.getenv(f'{exchange_id.upper()}_API_KEY'),
                #     'secret': os.getenv(f'{exchange_id.upper()}_API_SECRET'),
                #     # Добавьте другие параметры, если нужны (password для Kraken, uid для OKX, options и т.д.)
                #     'enableRateLimit': True, # Включить управление Rate Limit для REST запросов (напр., load_markets)
                #     'timeout': 20000, # Увеличим таймаут на всякий случай (ms)
                #     'watchdog_tick': 10000, # Интервал проверки соединения для WS (ms)
                # })
                # Пока используем без ключей:
                exchange = exchange_class({
                    'enableRateLimit': True,
                    'timeout': 20000,
                    'watchdog_tick': 10000,
                })


                # exchange.verbose = True # Раскомментировать для детального логирования ccxt.pro


                # --- Проверка поддерживаемых методов WS ---
                methods = exchange.has # Словарь поддерживаемых методов
                # Проверяем наличие словаря методов и ключей в нем
                if not isinstance(methods, dict):
                    logger.warning(f"Биржа {exchange_id.upper()} не предоставила список методов через ccxt.pro. Пропускаем.")
                    async with self._data_lock:
                         # Устанавливаем статус ошибки, если список методов не получен
                         self._exchange_status[exchange_id] = 'error' # Общий статус ошибки
                    # Ждем перед следующей попыткой подключения к этой бирже
                    await asyncio.sleep(reconnect_delay)
                    reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY) # Экспоненциальный откат
                    continue # Переход к следующей итерации внешнего while loop


                supports_ob_ws = methods.get('watchOrderBook', False) # Поддерживает ли watchOrderBook?
                supports_ticker_ws = methods.get('watchTicker', False) # Поддерживает ли watchTicker?

                if not supports_ob_ws and not supports_ticker_ws:
                    logger.warning(f"Биржа {exchange_id.upper()} не поддерживает watchOrderBook и watchTicker по WebSocket через ccxt.pro. Пропускаем навсегда.")
                    async with self._data_lock:
                        # Устанавливаем специфический статус, если нет поддержки нужных WS методов
                        self._exchange_status[exchange_id] = 'no_ws_support'
                    break # Выходим из внешнего цикла, не пытаемся переподключиться


                logger.info(f"Биржа {exchange_id.upper()} поддерживает WS OB: {supports_ob_ws}, WS Ticker: {supports_ticker_ws}")


                # --- Загрузка рынков ---
                try:
                     # load_markets делает REST запрос. Он нужен для получения информации о парах (названия, точность, активность).
                     # Может занять время и упасть из-за сетевых проблем или rate limit.
                     # Rate limit для этого запроса управляется ccxtpro, если enableRateLimit=True.
                     logger.info(f"Загрузка рынков для {exchange_id.upper()}...")
                     await exchange.load_markets() # Загружаем информацию о всех парах на бирже

                     # Проверяем, что markets успешно загрузились
                     if exchange.markets is None or not isinstance(exchange.markets, dict):
                          logger.error(f"Ошибка: exchange.markets для {exchange_id.upper()} не загружены или имеют некорректный формат после load_markets. Пропускаем все пары для этой биржи.")
                          async with self._data_lock: self._exchange_status[exchange_id] = 'error'
                          await asyncio.sleep(reconnect_delay)
                          reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY)
                          continue # Пытаемся переподключиться ко всей бирже

                     logger.info(f"Рынки для {exchange_id.upper()} загружены успешно ({len(exchange.markets)} пар).")

                     # TODO: Реализовать загрузку информации о комиссиях вывода здесь, если нужно для точного сканера.
                     # Например: await exchange.fetch_deposit_withdraw_fees() (если поддерживается биржей)


                except Exception as e:
                     # Ловим ошибки загрузки рынков (RequestTimeout, NetworkError, ExchangeError и т.д.)
                     logger.error(f"Ошибка загрузки рынков для {exchange_id.upper()}: {e}. Пропускаем все пары для этой биржи.", exc_info=True)
                     async with self._data_lock: self._exchange_status[exchange_id] = 'error'
                     await asyncio.sleep(reconnect_delay)
                     reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY)
                     continue # Пытаемся переподключиться ко всей бирже


                # --- Запускаем задачи подписки на отслеживаемые пары ---
                tasks = [] # Список задач подписки для этой биржи
                tracked_pairs_on_exchange = [] # Список пар, которые мы действительно будем отслеживать
                failed_pairs = [] # Пары, для которых подписка не удалась (например, BadSymbol)

                # Создаем запись для этой биржи в current_market_data под локом
                # Данные для пар будут добавляться задачами подписки.
                async with self._data_lock:
                     self.current_market_data[exchange_id] = {}
                     # Устанавливаем статус 'connected' только после успешной загрузки рынков
                     self._exchange_status[exchange_id] = 'connected'


                for symbol in PAIRS_TO_TRACK_WS:
                     # Проверяем, поддерживается ли биржа эту пару и активна ли она в загруженных рынках
                     if symbol not in exchange.markets or (exchange.markets[symbol].get('active') is False and exchange.markets[symbol].get('active') is not None):
                         logger.warning(f"Пара {symbol} не поддерживается или неактивна на бирже {exchange_id.upper()}. Пропускаем подписку.")
                         continue

                     tracked_pairs_on_exchange.append(symbol)

                     # Подписываемся на ОБ для сканера арбитража (если поддерживается watchOrderBook)
                     if supports_ob_ws:
                        # Создаем отдельную задачу для подписки на ОБ для этой пары
                        tasks.append(asyncio.create_task(self._watch_order_book_for_pair(exchange, symbol)))
                        logger.debug(f"Создана задача _watch_order_book_for_pair для {symbol}@{exchange_id.upper()}")

                     # Подписываемся на Тикер (если поддерживается watchTicker)
                     # Тикеры могут быть полезны для MonitoredList, даже если для сканера нужны ОБ.
                     if supports_ticker_ws:
                        # Создаем отдельную задачу для подписки на Тикер для этой пары
                        tasks.append(asyncio.create_task(self._watch_ticker_for_pair(exchange, symbol)))
                        logger.debug(f"Создана задача _watch_ticker_for_pair для {symbol}@{exchange_id.upper()}")


                if not tasks:
                     # Если после проверки всех пар не удалось создать ни одной задачи подписки
                     logger.warning(f"Нет активных подписок для биржи {exchange_id.upper()} по заданным парам ({len(tracked_pairs_on_exchange)} поддерживаемых). Пропускаем навсегда.")
                     async with self._data_lock:
                         # Устанавливаем специфический статус, если нет подписок на пары
                         self._exchange_status[exchange_id] = 'no_pairs'
                     # Очищаем запись биржи из current_market_data, т.к. нет активных подписок
                     async with self._data_lock:
                          if exchange_id in self.current_market_data:
                               del self.current_market_data[exchange_id]
                     break # Выходим из внешнего цикла, не пытаемся переподключиться

                # Если задачи подписки были созданы:
                logger.info(f"Запущены задачи подписки для {exchange_id.upper()}: {len(tasks)} подписок для {len(tracked_pairs_on_exchange)} пар.")

                # Сбрасываем задержку переподключения к начальному значению при успешном запуске подписок
                reconnect_delay = 1

                # --- Ожидаем завершения задач подписки ---
                # asyncio.gather ожидает завершения всех переданных ему задач.
                # Если return_exceptions=False (по умолчанию), первое же необработанное исключение
                # в любой из задач будет проброшено здесь, прерывая gather.
                # Это то, что нам нужно: если задача подписки упала из-за ошибки (которую
                # ccxt.pro watch цикл не смог обработать внутренне), мы считаем это
                # критической ошибкой для этой биржи и пытаемся переподключиться ко всей бирже.
                await asyncio.gather(*tasks, return_exceptions=False)

                # Если gather завершился без исключений, это означает, что ВСЕ задачи подписки
                # завершились без ошибок. В watch циклах такого быть не должно (они бесконечные),
                # кроме случаев отмены (CancelledError) или BadSymbol (которые ловятся внутри watch_*_for_pair
                # и приводят к выходу из конкретного watch цикла, но не всей задачи _watch_exchange).
                # Если мы дошли сюда, возможно, что-то пошло не так, и все watch циклы завершились.
                logger.info(f"MarketDataService: Все подзадачи подписки для {exchange_id.upper()} завершены (или упали). Переподключение.")
                # Если gather завершился, это считается ошибкой (кроме CancelledError, которая ловится выше)
                # Устанавливаем статус ошибки для биржи и цикл while self._running: попытается переподключиться.
                async with self._data_lock: self._exchange_status[exchange_id] = 'error'
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY)


            except asyncio.CancelledError:
                 # Эта ошибка ловится здесь, если родительская задача (например, MarketDataService.stop) отменила эту задачу _watch_exchange
                 logger.info(f"Задача _watch_exchange для {exchange_id.upper()} отменена.")
                 # Устанавливаем статус отключения, если он не был уже установлен на специфическую ошибку
                 async with self._data_lock:
                     if self._exchange_status.get(exchange_id) not in ['auth_error', 'no_ws_support', 'no_pairs']:
                         self._exchange_status[exchange_id] = 'disconnected'
                 break # Выходим из внешнего while self._running: цикла при отмене

            except (AuthenticationError) as e:
                 # Эта ошибка возникает, если API ключи некорректны или отсутствуют для аутентифицированных подписок.
                 # Считаем эту ошибку критической, не пытаемся переподключиться.
                 logger.error(f"Критическая ошибка аутентификации при подключении к {exchange_id.upper()} по WS: {e}. Пропускаем навсегда.", exc_info=True)
                 async with self._data_lock: self._exchange_status[exchange_id] = 'auth_error' # Специфический статус ошибки
                 break # Выходим из внешнего цикла навсегда

            # Ловим различные типы ошибок соединения и протокола, которые ccxt.pro может пробросить
            except (ExchangeError, NetworkError, BaseError, OperationRejected, RequestTimeout, NotSupported, ArgumentsRequired) as e:
                 # Эти ошибки считаются временными проблемами или проблемами конфигурации (кроме NotSupported/ArgumentsRequired, которые могут быть постоянными)
                 # Пытаемся переподключиться после задержки.
                 error_type = type(e).__name__
                 logger.error(f"Ошибка типа {error_type} с {exchange_id.upper()} по WS: {e}. Попытка переподключения через {reconnect_delay}с.", exc_info=True)
                 async with self._data_lock: self._exchange_status[exchange_id] = 'error' # Общий статус ошибки для временных проблем
                 # Переподключение происходит в следующей итерации внешнего while loop
                 await asyncio.sleep(reconnect_delay) # Ждем перед следующей попыткой
                 reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY) # Экспоненциальный откат

            except Exception as e:
                # Ловим любые другие неожиданные ошибки, которые могут произойти во внешнем цикле _watch_exchange
                logger.error(f"Неожиданная ошибка в _watch_exchange для {exchange_id.upper()}: {e}. Попытка переподключения через {reconnect_delay}с.", exc_info=True)
                async with self._data_lock: self._exchange_status[exchange_id] = 'error'
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, MAX_RECONNECT_DELAY)


            finally:
                # Этот блок выполняется при выходе из try (нормальное завершение gather)
                # или при возникновении исключения, которое не поймано внутри watch_*_for_pair
                # (т.е. большинство ошибок, кроме CancelledError и AuthError, которые ловятся выше).
                # Также выполняется при выходе из while loop (BadSymbol, No WS Support, No Pairs, Auth Error, CancelledError).

                # --- Корректное закрытие соединения ccxt.pro ---
                # Проверяем, был ли создан объект биржи и имеет ли он метод close.
                if exchange and hasattr(exchange, 'close'):
                     try:
                         # Проверяем readyState, чтобы избежать ошибок при закрытии уже закрытого соединения.
                         # ccxt.pro хранит информацию о состоянии соединения в клиентах.
                         # Простой способ проверить, активно ли хоть одно соединение:
                         is_any_client_open = False
                         if hasattr(exchange, 'clients') and isinstance(exchange.clients, dict):
                             for client in exchange.clients.values():
                                  # Проверяем, что клиент существует и имеет соединение со статусом OPEN
                                  if client and hasattr(client, 'connection') and client.connection and client.connection.state == 'OPEN':
                                       is_any_client_open = True
                                       break

                         if is_any_client_open:
                            logger.info(f"Closing WebSocket connection for {exchange_id.upper()}...")
                            await exchange.close() # Асинхронное закрытие соединения
                            logger.info(f"WebSocket connection for {exchange_id.upper()} closed.")
                         # else:
                            # logger.debug(f"WebSocket connection for {exchange_id.upper()} was not open or already closed.")

                     except Exception as close_e:
                         # Ловим ошибки при попытке закрытия соединения
                         logger.error(f"Ошибка при закрытии соединения WS для {exchange_id.upper()}: {close_e}", exc_info=True)

                # --- Очистка данных и обновление статуса в хранилище при завершении задачи ---
                # Доступ к разделяемому состоянию под локом
                async with self._data_lock:
                    current_status = self._exchange_status.get(exchange_id, 'unknown') # Получаем текущий статус

                    # Очищаем данные для этой биржи из хранилища при завершении задачи,
                    # ЕСЛИ только статус не является одним из "постоянных" (не требующих переподключения и данных)
                    # или если статус был 'connected' и мы вышли не по отмене (значит, была ошибка)
                    # Если статус был 'connected' и мы вышли из-за ошибки (не CancelledError),
                    # то gather пробросит исключение, которое будет поймано в try _watch_exchange
                    # и статус будет установлен на 'error'. Если же завершение gather
                    # произошло без исключения (что странно), то статус будет 'connected'.
                    # В любом случае, если статус не 'auth_error', 'no_ws_support', 'no_pairs',
                    # очищаем данные, чтобы не хранить устаревшие данные от отключенной биржи.
                    if current_status not in ['auth_error', 'no_ws_support', 'no_pairs'] and exchange_id in self.current_market_data:
                        logger.debug(f"Очистка данных для {exchange_id.upper()} из хранилища в finally.")
                        del self.current_market_data[exchange_id]
                        #logger.debug(f"Размер current_market_data после очистки {exchange_id}: {len(self.current_market_data)}")

                    # Обновляем статус на 'disconnected', если задача завершилась не по специфической ошибке
                    # и не по отмене. Если вышла из-за ошибки (и статус 'error'), оставляем 'error'.
                    # Если статус был 'connected' и мы дошли сюда, вероятно, была ошибка, которую поймал gather
                    # (если return_exceptions=False) - статус должен быть установлен на 'error' выше.
                    # Если gather завершился нормально (не должно быть), статус 'connected' -> ставим 'disconnected'.
                    if current_status == 'connected': # Если статус был 'connected' перед выходом
                         self._exchange_status[exchange_id] = 'disconnected'
                    # Если статус был 'connecting' и мы дошли сюда, вероятно, была ошибка подключения, которую поймали выше.
                    # Статус 'error' уже установлен.

                    logger.debug(f"Финальный статус для {exchange_id.upper()} после finally: {self._exchange_status.get(exchange_id)}")


        # Этот лог выполняется только после полного выхода из внешнего while self._running: цикла
        logger.info(f"Задача _watch_exchange для {exchange_id.upper()} завершена навсегда.")


    # --- Методы для подписки на ОБ и Тикеры для конкретных пар ---
    # Эти методы вызываются из _watch_exchange как отдельные задачи для каждой пары/типа данных.
    # Они содержат внутренние async for циклы, которыми управляет ccxt.pro для получения данных и переподключений.
    # Они ловят BadSymbol для отписки от конкретной пары, но пробрасывают более критические ошибки выше
    # в _watch_exchange для переподключения всей биржи.

    async def _watch_order_book_for_pair(self, exchange, symbol: str):
        """
        Подписывается на обновления книги ордеров для конкретной пары на бирже.
        Получает данные, нормализует, сохраняет в self.current_market_data под локом.
        """
        exchange_id = exchange.id
        ob_data_key = f"{symbol}_ob" # Ключ для хранения в current_market_data
        logger.debug(f"WS: Подписка на OB для {symbol}@{exchange_id.upper()}...")

        # Внутренний цикл async for от ccxt.pro сам обрабатывает большинство ошибок подписки и переподключения
        # Внешний цикл while self._running: позволяет задаче завершиться при остановке сервиса
        while self._running:
            try:
                 # watch_order_book возвращает асинхронный генератор, который выдает обновления книги ордеров.
                 # ccxt.pro заботится о поддержании соединения и переподключениях.
                 order_book_data = await exchange.watch_order_book(symbol, limit=WS_ORDER_BOOK_DEPTH)
                 # order_book_data - это словарь, возвращаемый ccxt.pro parse_order_book
                 if order_book_data:
                     # Проверяем базовую структуру данных
                     if isinstance(order_book_data, dict) and \
                        isinstance(order_book_data.get('bids'), list) and \
                        isinstance(order_book_data.get('asks'), list):

                         # Создаем экземпляр NormalizedOrderBook Pydantic модели
                         # Дополнительная валидация данных уровней происходит при создании модели
                         try:
                             normalized_ob_pydantic = NormalizedOrderBook(
                                 exchange=exchange_id,
                                 symbol=order_book_data.get('symbol', symbol), # Используем символ из данных, если есть
                                 bids=order_book_data.get('bids', []), # Используем .get с пустым списком по умолчанию
                                 asks=order_book_data.get('asks', []),
                                 timestamp=order_book_data.get('timestamp'),
                                 datetime=order_book_data.get('datetime'),
                                 # Добавьте другие поля OB, если нужны в модели
                             )

                             # Получение блокировки для безопасной записи
                             async with self._data_lock:
                                 # Проверяем, что запись для этой биржи все еще существует в общем хранилище.
                                 # Это предотвращает ошибки записи, если родительская задача (_watch_exchange)
                                 # уже удалила запись биржи из-за критической ошибки или отключения.
                                 if exchange_id in self.current_market_data:
                                     # Сохраняем нормализованный OB под локом
                                     self.current_market_data[exchange_id][ob_data_key] = normalized_ob_pydantic
                                     logger.debug(f"WS OB: Обновление для {symbol}@{exchange_id.upper()}.")
                                 # else:
                                     # logger.debug(f"WS OB: Биржа {exchange_id.upper()} отсутствует в current_market_data. Пропускаем обновление для {symbol}.")


                         except Exception as validation_error:
                             # Ошибка при создании Pydantic модели или при работе с _data_lock
                             logger.warning(f"WS OB: Ошибка валидации/создания модели или записи для {symbol}@{exchange_id.upper()}: {validation_error}. Данные: {order_book_data}. Пропускаем обновление.")
                             # Продолжаем цикл async for, чтобы получить следующее обновление

                     else:
                         logger.warning(f"WS OB: Получены некорректные данные (не dict с bids/asks) для {symbol}@{exchange_id.upper()}. Пропускаем обновление: {order_book_data}.")
                         # Продолжаем цикл async for

                # else:
                     # logger.debug(f"WS OB: Получено пустое обновление для {symbol}@{exchange_id.upper()}.")
                     # Продолжаем цикл async for

            except asyncio.CancelledError:
                 # Ловится при отмене задачи _watch_order_book_for_pair родительской задачей _watch_exchange
                 logger.info(f"WS: Задача _watch_order_book для {symbol}@{exchange_id.upper()} отменена.")
                 break # Выходим из async for и внешнего while loop

            except BadSymbol:
                 # Эта ошибка возникает, если запрошенная пара не поддерживается биржей для watchOrderBook подписки.
                 # Считаем это постоянной ошибкой для этой пары на этой бирже.
                 logger.warning(f"WS: Пара {symbol} не поддерживается биржей {exchange_id.upper()} для watchOrderBook. Отписка от этой пары.")
                 # Удаляем любые существующие данные для этой пары под локом при отписке
                 async with self._data_lock:
                      if exchange_id in self.current_market_data:
                          if ob_data_key in self.current_market_data[exchange_id]:
                              del self.current_market_data[exchange_id][ob_data_key]
                              logger.debug(f"Данные для {symbol}@{exchange_id.upper()} очищены после BadSymbol.")
                         # TODO: Опционально: Если для этой биржи больше нет данных по другим парам/тикеру после удаления этой пары,
                         # можно пометить биржу как не имеющую активных подписок или даже удалить ее запись целиком.
                         # Но безопаснее оставить это на ответственность родительской задачи _watch_exchange,
                         # которая может проверить количество оставшихся данных или задач.

                 break # Выходим из async for и внешнего while loop навсегда для этой пары

            except Exception as e:
                # Ловим любые другие неожиданные ошибки, которые могут произойти внутри watch_order_book loop.
                # Ccxt.pro watch методы сами ловят большинство ошибок соединения/протокола (NetworkError, ExchangeError, etc.)
                # и пытаются переподключиться внутренне. Эта ветка ловит ошибки, которые они не поймали
                # (например, ошибки при обработке данных биржи), или ошибки, которые ccxt.pro
                # считает достаточно критическими, чтобы пробросить выше (но не BadSymbol).
                # Эти ошибки будут проброшены из async for и пойманы внешним try/except в _watch_exchange,
                # вызывая переподключение всей биржи.
                # Здесь мы можем просто логировать их перед тем, как они будут проброшены.
                error_type = type(e).__name__
                logger.error(f"WS OB: Неожиданная ошибка типа {error_type} в watch_order_book для {symbol}@{exchange_id.upper()}: {e}. Пробрасываем для переподключения биржи.", exc_info=True)
                # Не ждем и не ловим исключение здесь, просто даем ему проброситься.
                # Если мы дошли сюда, это, вероятно, проблема, которую должен обработать _watch_exchange.
                raise # Пробрасываем исключение

        # Этот лог выполняется после выхода из while self._running: loop (при отмене или BadSymbol)
        logger.info(f"WS: Задача _watch_order_book для {symbol}@{exchange_id.upper()} завершена.")


    async def _watch_ticker_for_pair(self, exchange, symbol: str):
        """
        Подписывается на обновления тикера для конкретной пары на бирже через WebSocket.
        Получает данные, нормализует, сохраняет в self.current_market_data под локом.
        """
        exchange_id = exchange.id
        ticker_data_key = symbol # Ключ для хранения в current_market_data (например, 'BTC/USDT')
        logger.debug(f"WS: Подписка на Ticker для {symbol}@{exchange_id.upper()}...")

        # Внешний цикл while self._running: для обработки отмены задачи сервиса
        # Внутренний async for от ccxt.pro сам обрабатывает большинство ошибок подписки и переподключения
        while self._running:
             try:
                 # watch_ticker возвращает асинхронный генератор, который выдает обновления тикера.
                 # ccxt.pro заботится о поддержании соединения и переподключениях.
                 ticker_data = await exchange.watch_ticker(symbol)

                 if ticker_data:
                     # Проверяем, что основные числовые поля присутствуют и имеют правильный тип (или None)
                     # Используем .get() для безопасного доступа к ключам
                     bid = ticker_data.get('bid')
                     ask = ticker_data.get('ask')
                     last = ticker_data.get('last')

                     # Проверяем, что bid, ask, last, если они есть, являются числами или None.
                     # Это базовая валидация перед созданием модели.
                     if (bid is None or isinstance(bid, (int, float))) and \
                        (ask is None or isinstance(ask, (int, float))) and \
                        (last is None or isinstance(last, (int, float))):

                        try:
                            # Создаем экземпляр NormalizedTicker Pydantic модели
                            normalized_ticker = NormalizedTicker(
                                exchange=exchange_id,
                                symbol=ticker_data.get('symbol', symbol), # Используем символ из данных, если есть
                                bid=bid,
                                ask=ask,
                                last=last,
                                timestamp=ticker_data.get('timestamp'), # timestamp в ms (опционально)
                                datetime=ticker_data.get('datetime'), # дата/время ISO8601 строки (опционально)
                                # Добавьте другие поля тикера, если нужны в модели
                            )

                            # Получение блокировки для безопасной записи
                            async with self._data_lock:
                                # Проверяем, что запись для этой биржи все еще существует в общем хранилище.
                                # Это предотвращает ошибки записи, если родительская задача (_watch_exchange)
                                # уже удалила запись биржи из-за критической ошибки или отключения.
                                if exchange_id in self.current_market_data:
                                    # Сохраняем нормализованный тикер в словарь для этой биржи под ключом символа
                                    # Например: self.current_market_data['binance']['BTC/USDT'] = NormalizedTicker(...)
                                    self.current_market_data[exchange_id][ticker_data_key] = normalized_ticker
                                    logger.debug(f"WS Ticker: Обновление для {symbol}@{exchange_id.upper()}.")
                                # else:
                                     # logger.debug(f"WS Ticker: Биржа {exchange_id.upper()} отсутствует в current_market_data. Пропускаем обновление для {symbol}.")


                        except Exception as validation_error:
                            # Ошибка при создании Pydantic модели или при работе с _data_lock
                            logger.warning(f"WS Ticker: Ошибка валидации/создания модели или записи для {symbol}@{exchange_id.upper()}: {validation_error}. Данные: {ticker_data}. Пропускаем обновление.")
                            # Продолжаем цикл async for

                     else:
                          logger.warning(f"WS Ticker: Получены некорректные числовые поля для {symbol}@{exchange_id.upper()}. Данные: {ticker_data}. Пропускаем обновление.")
                          # Продолжаем цикл async for

                # else:
                     # logger.debug(f"WS Ticker: Получено пустое обновление для {symbol}@{exchange_id.upper()}.")
                     # Продолжаем цикл async for

             except asyncio.CancelledError:
                  # Ловится при отмене задачи _watch_ticker_for_pair родительской задачей _watch_exchange
                  logger.info(f"WS: Задача _watch_ticker для {symbol}@{exchange_id.upper()} отменена.")
                  break # Выходим из async for и внешнего while loop

             except BadSymbol:
                 # Эта ошибка возникает, если запрошенная пара не поддерживается биржей для watchTicker подписки.
                 # Считаем это постоянной ошибкой для этой пары на этой бирже.
                 logger.warning(f"WS: Пара {symbol} не поддерживается биржей {exchange_id.upper()} для watchTicker. Отписка от этой пары.")
                 # Удаляем любые существующие данные для этой пары под локом при отписке
                 async with self._data_lock:
                     if exchange_id in self.current_market_data:
                         if ticker_data_key in self.current_market_data[exchange_id]:
                             del self.current_market_data[exchange_id][ticker_data_key]
                             logger.debug(f"Данные для {symbol}@{exchange_id.upper()} очищены после BadSymbol.")
                         # TODO: Опционально: Если для этой биржи больше нет данных по другим парам/ОБ после удаления этой пары,
                         # можно пометить биржу как не имеющую активных подписок или даже удалить ее запись целиком.
                         # Но безопаснее оставить это на ответственность родительской задачи _watch_exchange,
                         # которая может проверить количество оставшихся данных или задач.
                 break # Выходим из async for и внешнего while loop навсегда для этой пары

             except Exception as e:
                # Ловим любые другие неожиданные ошибки, которые могут произойти внутри watch_ticker loop.
                # Эти ошибки будут проброшены из async for и пойманы внешним try/except в _watch_exchange,
                # вызывая переподключение всей биржи.
                error_type = type(e).__name__
                logger.error(f"WS Ticker: Неожиданная ошибка типа {error_type} в watch_ticker для {symbol}@{exchange_id.upper()}: {e}. Пробрасываем для переподключения биржи.", exc_info=True)
                # Не ждем и не ловим исключение здесь, просто даем ему проброситься.
                raise # Пробрасываем исключение


        # Этот лог выполняется после выхода из while self._running: loop (при отмене или BadSymbol)
        logger.info(f"WS: Задача _watch_ticker для {symbol}@{exchange_id.upper()} завершена.")


    async def _run_arbitrage_scanner(self):
        """
        Периодически запускает поиск арбитража на основе актуальных данных в памяти.
        Обновляет self.latest_opportunities и уведомляет WS подписчиков.
        Использует find_arbitrage_opportunities_with_order_book, которая
        возвращает возможности только >= MIN_PROFIT_PCT (Net).
        """
        logger.info("Запуск задачи поиска арбитража...")

        # Счетчик пропусков сканирования из-за недостатка данных
        skip_count = 0

        while self._running: # Цикл работы сканера, завершается при остановке сервиса
            start_time = time.time() # Время начала итерации сканера

            try:
                # --- Получаем копию данных ОБ под защитой блокировки для безопасного чтения ---
                # Сканер работает только с книгами ордеров.
                async with self._data_lock:
                     # Создаем словарь только с ОБ данными для сканера
                     market_data_for_scanner: Dict[str, Dict[str, NormalizedOrderBook]] = {}
                     # Итерируем по биржам в общем хранилище данных
                     # logger.debug(f"Scanner: current_market_data keys: {list(self.current_market_data.keys())}") # Отладка
                     for exchange_id, data_by_symbol in self.current_market_data.items():
                         # Проверяем, что биржа имеет статус, при котором мы ожидаем данные (подключена или в процессе подключения)
                         status = self._exchange_status.get(exchange_id, 'disconnected')
                         if status not in ['connected', 'connecting']:
                              # Пропускаем биржи, которые не подключены или в ошибке.
                              # logger.debug(f"Scanner: Skipping {exchange_id} due to status: {status}") # Отладка
                              continue

                         if isinstance(data_by_symbol, dict):
                             ob_data_for_exchange: Dict[str, NormalizedOrderBook] = {}
                             # Итерируем по элементам для символа в данных биржи
                             for symbol_key, data_item in data_by_symbol.items():
                                 # Если ключ заканчивается на '_ob' И данные являются NormalizedOrderBook
                                 if isinstance(symbol_key, str) and symbol_key.endswith('_ob') and isinstance(data_item, NormalizedOrderBook):
                                     ob_data_for_exchange[symbol_key] = data_item
                             # Добавляем биржу в снапшот для сканера, только если у нее есть хотя бы одна ОБ
                             if ob_data_for_exchange:
                                 market_data_for_scanner[exchange_id] = ob_data_for_exchange

                # ----------------------------------------------------

                # Проверяем, достаточно ли данных для сканирования (минимум 2 биржи, у каждой есть OB хотя бы для одной пары)
                # Улучшенная проверка: нужно минимум 2 биржи, и на этих 2+ биржах должна быть хотя бы ОДНА ОБЩАЯ пара
                # с доступными ОБ.
                has_enough_data = False
                if len(market_data_for_scanner) >= 2:
                     # Собираем все пары (убираем '_ob' суффикс), по которым есть ОБ на всех подключенных биржах в снапшоте
                     all_ob_symbols: Dict[str, Set[str]] = {} # Словарь: {symbol: {exchange1_id, exchange2_id, ...}}
                     for exchange_id, ob_data_by_symbol in market_data_for_scanner.items():
                          for symbol_key in ob_data_by_symbol.keys():
                              symbol = symbol_key[:-3] # Удаляем '_ob' суффикс
                              if symbol not in all_ob_symbols:
                                  all_ob_symbols[symbol] = set()
                              all_ob_symbols[symbol].add(exchange_id)

                     # Проверяем, есть ли хоть одна пара, которая есть на >= 2 биржах с ОБ
                     for symbol, exchanges_set in all_ob_symbols.items():
                          if len(exchanges_set) >= 2:
                              has_enough_data = True
                              # logger.debug(f"Scanner: Found enough data. Pair {symbol} on {exchanges_set}") # Отладка
                              break # Нашли достаточно данных, выходим из цикла проверок пар

                if not has_enough_data:
                     # Если данных недостаточно, пропускаем текущий цикл сканирования.
                     # logger.debug("Недостаточно данных для сканирования арбитража (менее 2 подключенных бирж с OB для общей пары).")
                     skip_count += 1
                     # Логируем предупреждение реже, чтобы не загромождать логи
                     if skip_count % 10 == 0: # Логируем каждое 10-е предупреждение
                         logger.info(f"Сканер пропущен {skip_count} раз из-за недостатка данных (менее 2 подключенных бирж с OB для общей пары).")

                     # Отправляем пустой список возможностей всем подписчикам,
                     # чтобы фронтенд знал, что прибыльных возможностей временно нет (или данных недостаточно).
                     # self.latest_opportunities = [] # Не очищаем здесь, чтобы липкие возможности оставались на фронте
                     # Уведомляем подписчиков (даже пустым списком)
                     if self.active_ws_connections:
                           asyncio.create_task(self._notify_ws_subscribers([])) # Отправляем пустой список в отдельной задаче

                     # Ждем перед следующим запуском сканирования
                     await asyncio.sleep(SCANNER_INTERVAL_SECONDS)
                     continue # Переход к следующей итерации while self._running:


                # Если данных достаточно:
                if skip_count > 0:
                    # Если были пропуски, логируем, что сканер возобновляет работу
                    logger.info(f"Данных стало достаточно. Сканер продолжит работу после {skip_count} пропусков.")
                    skip_count = 0 # Сбрасываем счетчик пропусков


                # --- Запускаем функцию поиска арбитража ---
                # Эта функция принимает только данные ОБ, порог прибыли и лимиты объема из конфига.
                # Она возвращает список возможностей, уже отфильтрованных по Net прибыли >= MIN_PROFIT_PCT
                # и отсортированных по Net прибыли по убыванию.
                found_opportunities = find_arbitrage_opportunities_with_order_book(
                    market_data_for_scanner, # Передаем только актуальный снапшот ОБ данных
                    # MIN_PROFIT_PCT и DESIRED_TRADE_VOLUME_BASE берутся из src/config.py внутри scanner.py
                )

                # --- Обновляем self.latest_opportunities ---
                # Перезаписываем список последними найденными возможностями.
                # Этот список уже отфильтрован и отсортирован.
                self.latest_opportunities = found_opportunities

                # --- Логирование результатов сканирования ---
                end_time = time.time()
                scan_duration = end_time - start_time
                logger.info(f"\n--- Сканер (Net прибыль >= {MIN_PROFIT_PCT}%): Найдено {len(self.latest_opportunities)} возможностей (Время сканирования: {scan_duration:.4f} сек) ---")
                logger.info(f"market_data_for_scanner snapshot: {list(market_data_for_scanner.keys())}")
                if self.latest_opportunities:
                    # Логируем первые несколько найденных возможностей с Net прибылью
                    # Используем f-строки для форматирования вывода
                    for i, opp in enumerate(self.latest_opportunities[:10]): # Логируем до 10 первых возможностей
                         # Форматируем вывод для читаемости
                         net_profit_display = f"{opp.net_profit_pct:.4f}%" if isinstance(opp.net_profit_pct, (int, float)) else 'N/A'
                         net_quote_display = f"{opp.net_profit_quote:.2f} Quote" if isinstance(opp.net_profit_quote, (int, float)) else 'N/A'
                         gross_profit_display = f"{opp.potential_profit_pct:.4f}%" if isinstance(opp.potential_profit_pct, (int, float)) else 'N/A'
                         volume_display = f"{opp.executable_volume_base:.8f}" if isinstance(opp.executable_volume_base, (int, float)) else 'N/A'
                         fees_display = f"{opp.fees_paid_quote:.4f} Quote" if isinstance(opp.fees_paid_quote, (int, float)) else 'N/A'
                         buy_ex_display = opp.buy_exchange.upper() if opp.buy_exchange else 'N/A'
                         sell_ex_display = opp.sell_exchange.upper() if opp.sell_exchange else 'N/A'
                         symbol_display = opp.symbol if opp.symbol else 'N/A'

                         logger.info(f"  {i+1}. {symbol_display:<10} BUY {buy_ex_display:<10} SELL {sell_ex_display:<10} "
                                     f"Net: {net_profit_display} ({net_quote_display}) "
                                     f"Gross: {gross_profit_display} "
                                     f"Vol: {volume_display} "
                                     f"Fees: {fees_display}"
                                     f" ID: {opp.id}" # ID возможности для отладки
                                    )
                    logger.info("-----------------------------------------------------------------------------------------")
                # else:
                #      logger.info("--- Сканер не нашел возможностей с Net прибылью выше порога ---")


                # --- Уведомляем WS подписчиков ---
                # Отправляем список, который уже в self.latest_opportunities (отфильтрован и отсортирован).
                # Отправляем даже пустой список, если возможностей не найдено.
                if self.active_ws_connections:
                     # Запускаем отправку сообщений в отдельной задаче asyncio,
                     # чтобы процесс сканирования не блокировался ожиданием отправки сообщений.
                     asyncio.create_task(self._notify_ws_subscribers(self.latest_opportunities))


            except asyncio.CancelledError:
                 # Ловится, если задача сканера отменяется (например, при MarketDataService.stop)
                 logger.info("Задача _run_arbitrage_scanner отменена.")
                 break # Выходим из while self._running: цикла

            except Exception as e:
                # Ловим любые другие неожиданные ошибки в процессе сканирования
                logger.error(f"Неожиданная ошибка в _run_arbitrage_scanner: {e}", exc_info=True)
                # При ошибке просто ждем и продолжаем, чтобы сканер не остановился полностью

            # --- Пауза перед следующим запуском сканера ---
            # Вычисляем время, которое фактически заняло сканирование,
            # и вычитаем его из заданного интервала SCANNER_INTERVAL_SECONDS,
            # чтобы следующий запуск был приблизительно через SCANNER_INTERVAL_SECONDS
            # после *начала* предыдущего сканирования.
            elapsed_time = time.time() - start_time
            time_to_sleep = max(0, SCANNER_INTERVAL_SECONDS - elapsed_time)
            # logger.debug(f"Scanner: Elapsed time: {elapsed_time:.4f}s, Sleeping for {time_to_sleep:.4f}s")
            await asyncio.sleep(time_to_sleep) # Ждем оставшееся время до следующего интервала


        # Этот лог выполняется только после полного выхода из внешнего while self._running: цикла
        logger.info("Задача _run_arbitrage_scanner завершена.")


    # --- Метод для получения статуса бирж (для фронтенда) ---
    async def get_exchange_statuses(self) -> Dict[str, str]:
        """
        Возвращает словарь с текущими статусами подключения бирж.
        Использует _data_lock для безопасного доступа к _exchange_status.
        Этот метод асинхронный и вызывается из асинхронного REST эндпоинта.
        """
        # Захватываем блокировку для безопасного доступа к _exchange_status
        async with self._data_lock:
             # Возвращаем копию словаря статусов, чтобы внешний код не мог его модифицировать напрямую.
             return self._exchange_status.copy()

# --- Конец класса MarketDataService ---

# Если используются вспомогательные функции нормализации из src/utils.py, импортируйте их здесь:
# from src.utils import normalize_ccxt_ticker, normalize_ccxt_order_book
