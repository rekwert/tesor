from fastapi import WebSocket, WebSocketDisconnect, APIRouter, Request # Импортируем APIRouter и Request
import json
import traceback

# Импортируем КЛАСС MarketDataService (для типизации)
# Экземпляр сервиса получаем из app.state в хэндлере
from src.market_data_service import MarketDataService # Импортируем КЛАСС

# Импортируем модель возможности (для сериализации)
from src.market_data_service import ArbitrageOpportunity # Импортируем модель


# --- Создаем APIRouter ---
router = APIRouter()


# --- Добавление WebSocket эндпоинта на роутер ---
# WS хэндлеры получают объект WebSocket.
# Объект приложения (и его state) доступен через websocket.app
@router.websocket("/ws_final") # Финальное имя WebSocket эндпоинта
async def websocket_endpoint_final(websocket: WebSocket):
    """
    WebSocket эндпоинт для отправки арбитражных возможностей в реальном времени.
    """
    await websocket.accept()
    print(f"WS: Клиент {websocket.client.host}:{websocket.client.port} подключен к /ws_final.")

    # --- Получаем экземпляр MarketDataService из состояния приложения ---
    # Предполагаем, что экземпляр сервиса сохранен в app.state под ключом 'market_data_service'
    service: MarketDataService = websocket.app.state.market_data_service
    # Проверяем, что получили нужный тип объекта
    if not isinstance(service, MarketDataService):
         print("Ошибка WS: MarketDataService не найден в app.state или имеет некорректный тип.")
         # Отправляем ошибку клиенту и закрываем соединение
         await websocket.send_text(json.dumps({"error": "Internal server error: Service not available."}))
         await websocket.close()
         return
    # -----------------------------------------------------------------


    # Подписываем клиента на обновления возможностей, получая его личную очередь
    client_queue = await service.subscribe_ws()
    print(f"WS: Клиент {websocket.client.host}:{websocket.client.port} подписан на обновления.")

    try:
        # Опционально: Отправить клиенту текущий список возможностей сразу при подключении
        # latest = service.get_latest_opportunities()
        # if latest:
        #      try:
        #          # Отправляем список как JSON строку
        #          await websocket.send_text(json.dumps([opp.model_dump() for opp in latest]))
        #          print(f"WS: Отправлены текущие возможности новому подписчику {websocket.client.host}:{websocket.client.port}.")
        #      except Exception as e:
        #          print(f"Ошибка при отправке текущих возможностей клиенту {websocket.client.host}:{websocket.client.port}: {e}")


        # В бесконечном цикле ждем сообщений в очереди клиента и отправляем их по WebSocket
        while True:
             # Ждем сообщения из очереди (это блокирующая операция для этой корутины)
             # Она разблокируется, когда в очередь будет что-то положено (_notify_ws_subscribers)
             message = await client_queue.get()

             # Проверяем сигнал остановки (если мы будем его использовать, например, None)
             if message is None:
                  # Получен сигнал остановки, выходим из цикла
                  print(f"WS: Получен сигнал остановки для клиента {websocket.client.host}:{websocket.client.port}.")
                  break

             # Отправляем сообщение (JSON строку) клиенту по WebSocket
             await websocket.send_text(message)
             # print(f"WS: Отправлено сообщение клиенту {websocket.client.host}:{websocket.client.port}.")


    except asyncio.CancelledError:
         print(f"WS: Задача websocket_endpoint_final для {websocket.client.host}:{websocket.client.port} отменена.")
         # При отмене задачи (например, при остановке сервиса), просто выходим из цикла
         # raise # Не пробрасываем отмену дальше, чтобы не вызвать ошибки в gather выше
    except WebSocketDisconnect:
        # Клиент отключился (закрытие соединения по инициативе клиента)
        print(f"WS: Клиент {websocket.client.host}:{websocket.client.port} отключен.")
    except Exception as e:
        # Неожиданная ошибка при работе с WebSocket
        print(f"WS: Ошибка при работе с клиентом {websocket.client.host}:{websocket.client.port}: {e}")
        traceback.print_exc() # Выводим полный traceback ошибки

    finally:
        # Этот блок выполняется всегда при выходе из try/except (например, при break или исключении)
        # В любом случае (отключение клиента или ошибка), отписываем его
        await service.unsubscribe_ws(client_queue)
        # Убеждаемся, что соединение закрыто (FastAPI делает это сам при WebSocketDisconnect)
        try:
            # Пытаемся закрыть соединение, если оно еще открыто
            await websocket.close()
            # print(f"WS: Соединение для клиента {websocket.client.host}:{websocket.client.port} принудительно закрыто.")
        except Exception:
            pass # Соединение уже могло быть закрыто
