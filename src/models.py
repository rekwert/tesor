from pydantic import BaseModel
from typing import List, Tuple, Dict

# Модель для нормализованных данных тикера
class NormalizedTicker(BaseModel):
    exchange: str          # ID биржи (например, 'binance')
    symbol: str            # Стандартизированный символ пары (например, 'BTC/USDT')
    bid: float             # Лучшая цена покупки
    ask: float             # Лучшая цена продажи
    last: float | None = None # Последняя цена сделки (может отсутствовать)
    timestamp: int | None = None # Unix timestamp в миллисекундах (время данных)
    datetime: str | None = None # ISO 8601 дата/время
    # Можно добавить другие поля, если они понадобятся, например, volume, vwap и т.д.

# Модель для нормализованной книги ордеров
class NormalizedOrderBook(BaseModel):
    exchange: str
    symbol: str
    bids: List[Tuple[float, float]] # Список [price, volume] для предложений покупки
    asks: List[Tuple[float, float]] # Список [price, volume] для предложений продажи
    timestamp: int | None = None
    datetime: str | None = None
    # nonce: int | None = None # Можно добавить, если нужно отслеживать версии книги

# Модель для найденной арбитражной возможности (пока простая, расширим позже)
class ArbitrageOpportunity(BaseModel):
    symbol: str            # Стандартизированный символ пары
    buy_exchange: str      # Биржа для покупки
    sell_exchange: str     # Биржа для продажи
    buy_price: float       # Цена покупки (Lowest Ask на бирже продажи!)
    sell_price: float      # Цена продажи (Highest Bid на бирже покупки!)
    potential_profit_pct: float # Потенциальная прибыль в процентах (до комиссий)
    timestamp: int         # Время, когда возможность была найдена (Unix timestamp ms)
    # Добавить: volume_available (объем, который можно реализовать), комиссии, и т.д.