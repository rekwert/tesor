# src/main.py

import asyncio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any

# Импортируем наши сервисы и модели
from src.market_data_service import MarketDataService
from src.data_models import ArbitrageOpportunity, NormalizedTicker # Импортируем NormalizedTicker для эндпоинта /tickers
# Импортируем конфигурацию
from src.config import EXCHANGES_TO_TRACK_WS, PAIRS_TO_TRACK_WS

# Импортируем роутер для WS
from src.ws_endpoints import router # Импорт после создания app

import logging # Используем logging

# Настройка логирования
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# --- Инициализация MarketDataService ---
# Создаем экземпляр сервиса
market_data_service = MarketDataService()

# --- Инициализация FastAPI приложения ---
app = FastAPI(
    title="Crypto Arbitrage Scanner API",
    description="API for tracking cryptocurrency arbitrage opportunities across exchanges",
    version="0.1.0",
)

# --- Добавляем CORS Middleware ---
origins = [
    "http://localhost",
    "http://localhost:5173", # Порт для Create-React-App или Vite
    "http://127.0.0.1",
    "http://127.0.0.1:5173", # Порт для Create-React-App или Vite
    # Add your production frontend origins here
    # "http://your-production-frontend.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Добавляем экземпляр сервиса в app.state ---
app.state.market_data_service = market_data_service

# --- Подключаем роутер с WebSocket эндпоинтами ---
app.include_router(router) # Подключаем роутер

# --- Определение событий запуска и остановки приложения ---
@app.on_event("startup")
async def startup_event():
    logger.info("FastAPI startup event: Starting MarketDataService...")
    service = app.state.market_data_service
    # Запускаем сервис в виде задачи, чтобы не блокировать startup
    asyncio.create_task(service.start())
    logger.info("FastAPI startup event: MarketDataService start task created.")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("FastAPI shutdown event: Stopping MarketDataService...")
    service = app.state.market_data_service
    # Остановка сервиса включает уведомление WS клиентов и отмену всех задач
    await service.stop()
    logger.info("FastAPI shutdown event: MarketDataService stopped.")

# --- Определение API эндпоинтов (REST) ---
@app.get("/api/v1/opportunities", response_model=List[ArbitrageOpportunity])
async def get_opportunities(request: Request):
    """
    Возвращает список последних найденных арбитражных возможностей (чистая прибыль >= MIN_PROFIT_PCT).
    Данные предварительно отфильтрованы и отсортированы сканером.
    """
    service: MarketDataService = request.app.state.market_data_service
    # get_latest_opportunities синхронный и возвращает копию
    opportunities = service.get_latest_opportunities()
    return opportunities

@app.get("/status")
async def get_status(request: Request):
    """
    Возвращает текущий статус приложения и MarketDataService, включая статусы бирж.
    """
    service: MarketDataService = request.app.state.market_data_service
    # Вызываем АСИНХРОННЫЙ метод get_exchange_statuses и ожидаем его
    exchange_statuses = await service.get_exchange_statuses()

    return {
        "status": "running",
        "service_running": service._running, # Это синхронный доступ, флаг bool
        "exchange_statuses": exchange_statuses
    }

@app.get("/hello")
async def hello():
    return {"message": "Hello, FastAPI is working!"}

# --- ЭНДПОИНТ: Список мониторируемых пар и бирж (конфигурация) ---
@app.get("/api/v1/monitored_pairs", response_model=Dict[str, List[str]])
async def get_monitored_pairs():
    """
    Возвращает список всех бирж и пар, которые настроены для мониторинга из конфигурации.
    """
    monitored_data = {exchange: list(PAIRS_TO_TRACK_WS) for exchange in EXCHANGES_TO_TRACK_WS}
    return monitored_data

# --- ЭНДПОИНТ: Получение всех актуальных тикеров (ВРЕМЕННО для MonitoredList) ---
# TODO: Удалить этот эндпоинт, когда MonitoredList перейдет на WS тикеры
@app.get("/api/v1/tickers", response_model=Dict[str, Dict[str, NormalizedTicker]])
async def get_all_tickers(request: Request):
    """
    ВРЕМЕННО: Возвращает последние актуальные тикеры для всех отслеживаемых пар на всех биржах (по REST).
    Будет удален после перехода MonitoredList на WS.
    """
    service: MarketDataService = request.app.state.market_data_service
    tickers_data: Dict[str, Dict[str, NormalizedTicker]] = {}
    # Чтение current_market_data требует блокировки, поэтому этот эндпоинт должен быть async
    async with service._data_lock:
         # Перебираем все биржи в текущих данных
         for exchange_id, data_by_symbol in service.current_market_data.items():
             # Проверяем, что биржа имеет статус, при котором мы ожидаем данные
             status = service._exchange_status.get(exchange_id, 'disconnected')
             if status not in ['connected', 'connecting']:
                  # Пропускаем биржи в ошибке или отключенные
                  continue

             tickers_data[exchange_id] = {}
             if isinstance(data_by_symbol, dict):
                 # Перебираем все элементы для символа
                 for symbol_key, data_item in data_by_symbol.items():
                     # Если элемент является NormalizedTicker
                     if isinstance(data_item, NormalizedTicker):
                         tickers_data[exchange_id][symbol_key] = data_item

    return tickers_data
