// frontend/src/components/MonitoredList.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios'; // <-- Импорт axios для polling
import './MonitoredList.css'; // Стили только для этого компонента
import { formatTimeSince } from '../utils/timeUtils.js'; // Если нужно отображать время обновления тикера

// API endpoint URL for tickers (REST polling)
const API_URL_TICKERS = 'http://127.0.0.1:8000/api/v1/tickers'; // ВРЕМЕННО: REST эндпоинт для тикеров
// Polling interval for tickers
const POLLING_INTERVAL_MS_TICKERS = 5000; // Каждые 5 секунд


// TODO: Перенести логотипы на бэкенд или использовать централизованный источник
// Пока оставим здесь
const exchangeLogos = {
    bitget: '/logos/bitget.png',
    digifinex: '/logos/digifinex.png',
    exmo: '/logos/exmo.png',
    xt: '/logos/xt.png',
    bitmart: '/logos/bitmart.png',
    gateio: '/logos/gateio.png',
    kucoin: '/logos/kucoin.png',
    phemex: '/logos/phemex.png',
    coinw: '/logos/coinw.png',
    bitrue: '/logos/bitrue.png',
    hitbtc: '/logos/hitbtc.png',
};


// Принимаем monitoredData (config), exchangeStatuses (REST data) из App.jsx.
// actualTickers теперь ПОЛУЧАЕМ ВНУТРИ КОМПОНЕНТА через REST polling (временно)
function MonitoredList({
                           monitoredData = {}, // Список {биржа: [пары]} из конфига бэкенда (пропс из App.jsx)
                           exchangeStatuses = {}, // Статусы бирж {exchange: status} (пропс из App.jsx)
                           theme, // Тема
                           activePage, // Добавим activePage для активации polling
                       }) {

    // Локальное состояние для актуальных тикеров (получаем polling'ом)
    const [tickers, setTickers] = useState({}); // {exchange: {pair: NormalizedTicker}}
    // Локальное состояние для времени последнего обновления тикеров
    const [lastUpdated, setLastUpdated] = useState(null);
    // Локальное состояние для индикаторов загрузки/ошибок тикеров (polling)
    const [tickersLoading, setTickersLoading] = useState(false);
    const [tickerError, setTickerError] = useState(null);


    // State for local filters (эти локальные фильтры остаются, они специфичны для этой страницы)
    const [filterExchange, setFilterExchange] = useState('');
    const [filterPair, setFilterPair] = useState('');

    // State to track which exchanges are expanded
    // Инициализируем состояние развернутости только при первой загрузке monitoredData через пропс
    const [expandedExchanges, setExpandedExchanges] = useState({}); // { exchangeName: boolean }
    // Флаг для первой инициализации expandedExchanges
    const [isInitialDataLoaded, setIsInitialDataLoaded] = useState(false);


    // --- Эффект для REST polling тикеров ---
    useEffect(() => {
        let isMounted = true; // Флаг монтирования

        // Запускаем polling только если активна страница мониторинга
        if (activePage !== 'monitored') {
             console.log("MonitoredList: activePage not 'monitored', stopping ticker polling.");
            setTickers({}); // Очищаем тикеры при уходе со страницы
            setLastUpdated(null);
            setTickerError(null);
             setTickersLoading(false); // Убираем индикатор загрузки
             return () => {}; // Возвращаем пустую функцию очистки
        }

        console.log("MonitoredList: activePage is 'monitored', starting ticker polling.");

        const fetchTickers = async () => {
            if (!isMounted) return;
            setTickersLoading(true); // Начинаем загрузку
            setTickerError(null); // Сбрасываем предыдущую ошибку

            try {
                const response = await axios.get(API_URL_TICKERS);
                if (isMounted) {
                    // Ожидаем формат { "exchange_id": { "SYMBOL": { ...ticker data... }, ... }, ... }
                    if (typeof response.data === 'object' && response.data !== null) {
                         setTickers(response.data);
                         setLastUpdated(Date.now()); // Записываем время получения данных
                         console.log(`MonitoredList: Fetched tickers successfully for ${Object.keys(response.data).length} exchanges.`);
                    } else {
                         console.error("MonitoredList: Received invalid ticker data format:", response.data);
                         setTickerError("Некорректный формат данных тикеров."); // Русский текст
                    }
                     setTickersLoading(false); // Загрузка завершена (успех или некорректный формат)
                }
            } catch (err) {
                if (isMounted) {
                    console.error("MonitoredList: Error fetching tickers:", err);
                    setTickerError(`Ошибка загрузки тикеров: ${err.message}`); // Русский текст
                    setTickersLoading(false); // Загрузка завершена с ошибкой
                }
            }
        };

        // Первый вызов сразу
        fetchTickers();

        // Настраиваем интервал для последующих вызовов
        const intervalId = setInterval(fetchTickers, POLLING_INTERVAL_MS_TICKERS);

        // Функция очистки: выполняется при размонтировании компонента или изменении зависимостей
        return () => {
            isMounted = false; // Устанавливаем флаг в false
            console.log("MonitoredList: Cleaning up ticker polling interval.");
            clearInterval(intervalId);
        };

    }, [activePage]); // Зависит от activePage для старта/остановки polling'а


    // Эффект для инициализации expandedExchanges при получении monitoredData через пропс
    // Срабатывает при первом получении monitoredData и при очистке данных
    useEffect(() => {
        // Если monitoredData получен (не пустой) и это первая загрузка
        if (Object.keys(monitoredData).length > 0 && !isInitialDataLoaded) {
            console.log("MonitoredList: Initial monitoredData received, setting initial expanded state.");
            const initialExpanded = {};
            // Все развернуты по умолчанию
            Object.keys(monitoredData).forEach(exchange => {
                initialExpanded[exchange] = true;
            });
            setExpandedExchanges(initialExpanded);
            setIsInitialDataLoaded(true); // Отмечаем, что первая загрузка произошла
        }
        // Если monitoredData очищен (например, при смене страницы в App.jsx), сбрасываем флаг и состояния
         if (Object.keys(monitoredData).length === 0 && isInitialDataLoaded) {
              console.log("MonitoredList: monitoredData is empty, resetting state.");
              setIsInitialDataLoaded(false);
              setExpandedExchanges({}); // Очищаем состояние развернутости
              // actualTickers и exchangeStatuses управляются в App.jsx (но мы их получаем локально теперь)
              setFilterExchange(''); // Сбрасываем локальные фильтры
              setFilterPair('');
              setTickers({}); // Очищаем локальные тикеры тоже
              setLastUpdated(null);
              setTickerError(null);
         }

    }, [monitoredData, isInitialDataLoaded]); // Зависит от пропса monitoredData и флага


    // Логика фильтрации данных мониторинга (Мемоизировано)
    // Теперь фильтруем monitoredData (конфигурацию пар), но отображаем цены из *локальных* tickers
    const filteredData = useMemo(() => {
        // console.log("MonitoredList: Calculating filteredData...");
        const lowerFilterExchange = filterExchange.toLowerCase();
        const lowerFilterPair = filterPair.toLowerCase();
        const result = {};

        // Итерируем по конфигурационным данным monitoredData
        Object.keys(monitoredData).forEach(exchange => {
            // Фильтр по названию биржи
            if (lowerFilterExchange === '' || exchange.toLowerCase().includes(lowerFilterExchange)) {
                const pairs = monitoredData[exchange];
                // Фильтр пар внутри биржи
                const filteredPairs = Array.isArray(pairs) ? pairs.filter(pair =>
                    lowerFilterPair === '' || pair.toLowerCase().includes(lowerFilterPair)
                ) : [];

                // Добавляем биржу в результат, только если у нее есть пары после фильтрации
                if (filteredPairs.length > 0) {
                    result[exchange] = filteredPairs;
                }
            }
        });
         // console.log("MonitoredList: Filtered data:", result); // Отладка
        return result;
    }, [monitoredData, filterExchange, filterPair]); // Зависит от пропса monitoredData и локальных фильтров


    // Функция переключения состояния развернутости биржи
    const toggleExchange = useCallback((exchangeName) => {
        setExpandedExchanges(prevState => ({
            ...prevState,
            [exchangeName]: !prevState[exchangeName] // Инвертируем текущее состояние
        }));
    }, []); // Нет внешних зависимостей


    // Функция для обработки изменения фильтра пар (упрощенная)
    const handlePairFilterChange = useCallback((e) => {
        const value = e.target.value;
        setFilterPair(value);
        // При фильтрации по паре, не меняем автоматически состояние expandedExchanges.
        // Пользователь управляет этим кликами по заголовку биржи или кнопкой "Развернуть/Свернуть все".
        // Можно опционально разворачивать все биржи, содержащие совпадения, если фильтр не пуст,
        // но это делает логику сложнее. Проще оставить управление разворачиванием ручным.
    }, []); // Нет внешних зависимостей

     // Функция для разворачивания/сворачивания всех отфильтрованных бирж
     const toggleAllExpanded = useCallback(() => {
          // Определяем, все ли текущие *отфильтрованные* биржи развернуты
          // Проверяем, есть ли отфильтрованные данные, чтобы избежать ошибки every на пустом объекте
          const currentlyFilteredExchanges = Object.keys(filteredData);
          const allCurrentlyExpanded = currentlyFilteredExchanges.length > 0 &&
                                       currentlyFilteredExchanges.every(exchange => expandedExchanges[exchange]);

          const newExpanded = { ...expandedExchanges }; // Начинаем с текущего состояния

          // Инвертируем состояние развернутости только для тех бирж, которые видны после фильтрации
          currentlyFilteredExchanges.forEach(exchange => {
               newExpanded[exchange] = !allCurrentlyExpanded;
          });

          // Состояния для бирж, не попавших в currentlyFilteredExchanges, остаются без изменений.
          setExpandedExchanges(newExpanded);
     }, [filteredData, expandedExchanges]); // Зависит от отфильтрованных данных и текущего состояния развернутости


    // Проверяем, есть ли хоть какие-то данные в оригинальном списке мониторинга (из App.jsx)
    const hasOriginalData = Object.keys(monitoredData).length > 0;
    // Проверяем, есть ли данные после применения локальных фильтров
     const hasFilteredData = Object.keys(filteredData).length > 0;
     // Проверяем, активны ли какие-либо локальные фильтры (не модальные)
    const areLocalFiltersActive = filterExchange !== '' || filterPair !== '';


    // --- Вспомогательная функция для получения статуса биржи ---
    // Использует пропс exchangeStatuses из App.jsx
    const getExchangeStatusDisplay = useCallback((exchangeId) => {
         const status = exchangeStatuses[exchangeId?.toLowerCase()] ?? 'N/A'; // Используем lower()
         // Определяем класс для стилизации
         let statusClass = '';
         let statusText = status.toUpperCase(); // По умолчанию текст статуса в верхнем регистре
         switch (status) {
             case 'connecting':
                 statusClass = 'status-connecting';
                 statusText = 'ПОДКЛЮЧЕНИЕ...';
                 break;
             case 'connected':
                 statusClass = 'status-connected';
                 statusText = 'ПОДКЛЮЧЕНО';
                 break;
             case 'disconnected':
                 statusClass = 'status-disconnected';
                 statusText = 'ОТКЛЮЧЕНО';
                 break;
             case 'error':
                 statusClass = 'status-error';
                 statusText = 'ОШИБКА';
                 break;
             case 'auth_error':
                 statusClass = 'status-auth_error'; // Используем специфический класс
                 statusText = 'ОШИБКА АВТ.';
                 break;
             case 'no_ws_support':
                 statusClass = 'status-no_ws_support'; // Используем специфический класс
                 statusText = 'НЕТ WS'; // Нет поддержки WS
                 break;
              case 'no_pairs':
                  statusClass = 'status-no_pairs'; // Используем специфический класс
                 statusText = 'НЕТ ПАР'; // Нет отслеживаемых пар
                 break;
             default:
                 statusClass = 'status-unknown';
                 statusText = status.toUpperCase();
         }
         return <span className={`exchange-status-indicator ${statusClass}`}>{statusText}</span>;
    }, [exchangeStatuses]); // Зависит от пропса exchangeStatuses


    // Отображаем сообщения о состоянии данных мониторинга
    // Если нет исходных данных (monitoredData пуст) - App.jsx сам покажет сообщение
    // "Не настроены биржи или пары...".
    // MonitoredList отвечает только за отображение данных, если они есть, и локальных фильтров/сообщений.

     // Если есть исходные данные (monitoredData), но после применения локальных фильтров ничего не осталось
     // ИЛИ если нет исходных данных, но активны локальные фильтры (что странно)
     if ((hasOriginalData && !hasFilteredData && areLocalFiltersActive) || (!hasOriginalData && areLocalFiltersActive)) {
          return (
             <div className="monitored-list">
                 <h2>Мониторинг бирж и пар</h2> {/* Русский заголовок */}
                 {/* Поля фильтра */}
                 <div className="monitored-filters controls">
                     {/* ... поля фильтра ... */}
                      <input
                         type="text"
                         placeholder="Фильтр по бирже" // Русский текст
                         value={filterExchange}
                         onChange={(e) => setFilterExchange(e.target.value)} // Простая фильтрация по бирже не меняет expand state
                          aria-label="Фильтр по названию биржи"
                     />
                      <input
                         type="text"
                         placeholder="Фильтр по паре" // Русский текст
                         value={filterPair}
                         onChange={handlePairFilterChange} // Используем простую функцию для фильтрации пар
                          aria-label="Фильтр по названию пары"
                     />
                      {/* Кнопка развернуть/свернуть все */}
                      {/* Показываем кнопку только если есть данные для фильтрации/отображения */}
                      {Object.keys(filteredData).length > 0 && ( // Показываем кнопку только если есть что разворачивать/сворачивать после фильтров
                         <button onClick={toggleAllExpanded}>
                            {Object.keys(filteredData).every(exchange => expandedExchanges[exchange]) ? 'Свернуть все' : 'Развернуть все'} {/* Текст кнопки зависит от состояния отфильтрованных */}
                         </button>
                      )}
                 </div>
                 <p className="info-message">Ничего не найдено по заданным фильтрам.</p> {/* Русский текст */}
             </div>
         );
     }

    // Если нет исходных данных вообще (App.jsx не передал monitoredData или он пуст) И локальные фильтры не активны
    // Этот случай, вероятно, должен обрабатываться в App.jsx, показывая сообщение
    // "Не настроены биржи или пары для мониторинга.".
    // Но как fallback, можно показать здесь.
     if (!hasOriginalData && !areLocalFiltersActive) {
         // Показываем состояние загрузки тикеров или ошибку, если они есть, даже при отсутствии конфига.
         // Хотя без конфига тикеры бесполезны. Лучше показать сообщение о конфиге.
         return (
              <div className="monitored-list">
                  <h2>Мониторинг бирж и пар</h2> {/* Русский заголовок */}
                   {tickersLoading && <p className="info-message">Загрузка актуальных тикеров...</p>}
                   {tickerError && <p className="error-message">{tickerError}</p>}
                  {!tickersLoading && !tickerError && <p className="info-message">Не настроены биржи или пары для мониторинга (конфигурация не загружена).</p>} {/* Русский текст */}
             </div>
         );
     }


    // Если есть исходные данные и есть отфильтрованные данные, отображаем список мониторинга
    return (
        <div className="monitored-list"> {/* Класс для стилизации контейнера */}
            <h2>Мониторинг бирж и пар</h2> {/* Русский заголовок */}

            {/* Индикатор загрузки тикеров */}
             {tickersLoading && !tickerError && <p className="info-message">Загрузка актуальных тикеров...</p>}
             {/* Сообщение об ошибке загрузки тикеров */}
             {tickerError && <p className="error-message">{tickerError}</p>}
             {/* Время последнего обновления тикеров */}
             {lastUpdated && !tickersLoading && !tickerError && (
                 <p className="last-updated">
                      Последнее обновление тикеров: {formatTimeSince(lastUpdated)} назад
                 </p>
             )}


            {/* --- Поля фильтра --- */}
            <div className="monitored-filters controls"> {/* Используем общий класс .controls */}
                <input
                    type="text"
                    placeholder="Фильтр по бирже" // Русский placeholder
                    value={filterExchange}
                    onChange={(e) => setFilterExchange(e.target.value)} // Простая фильтрация по бирже
                     aria-label="Фильтр по названию биржи" // Для доступности
                />
                 <input
                    type="text"
                    placeholder="Фильтр по паре" // Русский placeholder
                    value={filterPair}
                    onChange={handlePairFilterChange} // Используем простую функцию для фильтрации пар
                     aria-label="Фильтр по названию пары" // Для доступности
                />
                 {/* Кнопка развернуть/свернуть все */}
                  {Object.keys(filteredData).length > 0 && ( // Показываем кнопку только если есть отфильтрованные биржи
                     <button onClick={toggleAllExpanded}>
                        {Object.keys(filteredData).every(exchange => expandedExchanges[exchange]) ? 'Свернуть все' : 'Развернуть все'}
                     </button>
                  )}
            </div>

            {/* --- Список бирж с функциональностью сворачивания --- */}
            <div className="exchanges-list">
                {/* Итерируем по ключам отфильтрованного объекта (названиям бирж) */}
                {Object.keys(filteredData).map(exchange => {
                    const exchangeIdLower = exchange.toLowerCase();
                     // Получаем актуальные тикеры для этой биржи (из локального состояния)
                    const exchangeTickers = tickers[exchangeIdLower] || {};

                    return (
                        <div key={exchange} className="exchange-section">
                            {/* Заголовок секции биржи - кликабелен для сворачивания */}
                            <button
                                 className="exchange-header"
                                 onClick={() => toggleExchange(exchange)}
                                 aria-expanded={!!expandedExchanges[exchange]} // Для доступности
                            >
                                 {/* Отображаем название биржи и ее статус подключения */}
                                 {/* Отображаем логотип, если есть */}
                                {exchangeLogos[exchangeIdLower] && (
                                    <img
                                        src={exchangeLogos[exchangeIdLower]}
                                        alt={`${exchange} logo`}
                                        className="exchange-logo"
                                        // Скрываем изображение при ошибке загрузки
                                        onError={(e) => { e.target.style.display = 'none'; console.warn(`Failed to load logo for ${exchange}`) }}
                                        style={{ marginRight: '5px' }} // Отступ от текста
                                    />
                                )}
                                 {exchange.toUpperCase()} {getExchangeStatusDisplay(exchange)}
                                 {/* Иконка развернуть/свернуть */}
                                 <span>{expandedExchanges[exchange] ? '▼' : '►'}</span>
                            </button>

                            {/* Контейнер с парами - отображается условно */}
                            {/* Используем expandedExchanges[exchange] для условного рендеринга */}
                            {expandedExchanges[exchange] && (
                                <div className="exchange-pairs-content">
                                    {/* Отображаем пары, которые прошли фильтр по паре */}
                                    {filteredData[exchange].length === 0 ? (
                                         <p className="info-message" style={{textAlign: 'left', margin: 0, fontStyle: 'normal', color: 'inherit', opacity: 0.8}}> {/* Уточняем стиль */}
                                             Нет пар по заданным фильтрам на этой бирже. {/* Русский текст */}
                                         </p>
                                    ) : (
                                        filteredData[exchange].map(pair => {
                                             // Получаем актуальный тикер для этой пары и биржи из локального состояния tickers
                                             const ticker = exchangeTickers[pair]; // Используем pair как ключ (он стандартизирован)
                                             const bid = ticker?.bid;
                                             const ask = ticker?.ask;
                                             const last = ticker?.last;

                                             // Форматируем отображение цены (bid/ask или last)
                                             let priceDisplay = 'Нет данных'; // Русский текст
                                             // TODO: Определить точность отображения для каждой пары. Сейчас 8 знаков.
                                             const precision = 8; // Пока используем 8 знаков для всех

                                             if (typeof bid === 'number' && typeof ask === 'number') {
                                                 priceDisplay = `Bid: ${bid.toFixed(precision)} / Ask: ${ask.toFixed(precision)}`;
                                             } else if (typeof last === 'number') {
                                                 priceDisplay = `Последняя: ${last.toFixed(precision)}`;
                                             } else {
                                                 // Если нет ни bid/ask ни last, возможно, тикер просто отсутствует для этой пары
                                                  priceDisplay = 'Нет данных тикера';
                                             }

                                            return (
                                                <div key={pair} className="monitored-pair-item">
                                                    <strong>{pair}</strong>: {priceDisplay}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                 {/* Сообщение, если ни одна биржа не соответствует фильтру по названию */}
                 {/* Показываем, если есть исходные данные, но отфильтрованных бирж нет, И локальный фильтр по бирже активен */}
                {hasOriginalData && Object.keys(filteredData).length === 0 && filterExchange !== '' && (
                    <p className="info-message" style={{textAlign: 'left', margin: 0, fontStyle: 'normal', color: 'inherit', opacity: 0.8, padding: '10px 15px'}}> {/* Уточняем стиль */}
                        Нет бирж по заданному локальному фильтру. {/* Русский текст */}
                    </p>
                )}
                 {/* Сообщение, если есть отфильтрованные биржи, но ни у одной нет пар по локальному фильтру пар */}
                 {/* (Этот случай уже обрабатывается внутри каждой секции биржи) */}
            </div>
             {/* TODO: Добавить индикатор, что данные тикеров могут быть неактуальными из-за polling */}
        </div>
    );
}

export default MonitoredList;