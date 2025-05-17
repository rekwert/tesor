// frontend/src/App.jsx
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import OpportunityTable from './components/OpportunityTable';
import OpportunityDetails from './components/OpportunityDetails';
import MonitoredList from './components/MonitoredList'; // MonitoredList теперь получает тикеры polling'ом локально
import HomePage from './components/HomePage';
import FilterModal from './components/FilterModal';
import SettingsModal from './components/SettingsModal';
import Pagination from './components/Pagination';
import SearchInput from './components/SearchInput';

// Утилиты времени.
import { formatTimeSince } from './utils/timeUtils.js';

// Убедитесь, что эти CSS файлы не конфликтуют
import './App.css';
import './index.css';


// API endpoint URLs
// REST для возможностей не нужен, используем WS, но эндпоинт оставим как fallback
// const API_URL_OPPORTUNITIES = 'http://127.0.0.1:8000/api/v1/opportunities'; // Используем WS
const API_URL_MONITORED = 'http://127.0.0.1:8000/api/v1/monitored_pairs'; // Нужен для списка фильтров
const API_URL_STATUS = 'http://127.0.0.1:8000/status'; // Нужен для статуса бирж и сервиса (Polling)

// WebSocket endpoint URL - Используем текущий хост, но с протоколом ws/wss и эндпоинтом бэкенда
// Предполагаем, что бэкенд на том же хосте, порт 8000
const WS_URL = `ws://${window.location.host.split(':')[0]}:8000/ws_final`;

// Время, в течение которого "исчезнувшая" возможность остается видимой в таблице (ms)
const STICKY_DURATION_MS = 300000; // 5 минут
// Интервал для "сборки мусора" старых исчезнувших возможностей (ms)
const GC_INTERVAL_MS = 60000; // 1 минута

// Задержка перед попыткой переподключения WS (ms)
const WS_RECONNECT_DELAY_MS = 5000;
// Максимальная задержка перед переподключением WS (ms)
const MAX_WS_RECONNECT_DELAY_MS = 60000; // 60 секунд

// Интервал для polling'а статуса бирж (ms)
const STATUS_POLLING_INTERVAL_MS = 10000; // Каждые 10 секунд


// Начальные значения для пользовательских настроек комиссий и инвестиций (для локального калькулятора)
const INITIAL_BUY_COMMISSION_PCT = 0.1; // Пример: 0.1%
const INITIAL_SELL_COMMISSION_PCT = 0.1; // Пример: 0.1%
const INITIAL_CALC_INVESTMENT_AMOUNT = 100; // Сумма в USD/USDT для расчета прибыли в $ в модалке деталей


// Helper function to compare raw opportunity data for significant changes
// Используется для определения, действительно ли возможность "обновилась" в новом фиде WS.
// Сравнивает только поля, которые приходят с бэкенда.
const areOpportunitiesEqual = (opp1, opp2) => {
    if (!opp1 || !opp2) return false;

    // Сравниваем ключевые поля. ID не сравниваем, т.к. это ключ.
    // Используем строковое сравнение с фиксированной точностью для чисел с плавающей точкой
    // для надежности сравнения, но можно и просто numbers сравнивать, если точность не критична.
    // Precision matching backend's toFixed(8) for prices, toFixed(4) for percents/fees? Let's use 8 for all floats.
    const floatPrecision = 8;

    // Сравниваем поля, которые приходят с бэкенда
    const fieldsToCompare = [
        'symbol', 'buy_exchange', 'sell_exchange',
        'buy_price', 'sell_price', 'potential_profit_pct',
        'executable_volume_base', 'fees_paid_quote', 'net_profit_pct', 'net_profit_quote',
        'buy_network', 'sell_network', 'timestamp' // timestamp с бэкенда в ms
    ];

    for (const field of fieldsToCompare) {
        const val1 = opp1[field];
        const val2 = opp2[field];

        // Сравниваем значения. Специфическая обработка для чисел.
        if (typeof val1 === 'number' && typeof val2 === 'number') {
            // Сравниваем числа с плавающей точкой с учетом точности
             // Проверяем на NaN, т.к. (NaN).toFixed() выбросит ошибку
             if (!isNaN(val1) && !isNaN(val2) && val1.toFixed(floatPrecision) !== val2.toFixed(floatPrecision)) return false;
             if (isNaN(val1) !== isNaN(val2)) return false; // Если одно NaN, а другое нет
        } else if (val1 !== val2) { // Сравниваем все остальное (строки, null, undefined, NaN как значение)
             return false;
        }
    }

    return true; // Если все сравниваемые поля равны
};


function App() {
    // --- Состояния приложения ---
    // opportunitiesMap - мастер-список всех возможностей, включая "исчезнувшие", хранится как Map
    // Ключ Map - стабильный ID возможности (string) с бэкенда: opportunity.id
    // Значение Map - объект возможности с полями с бэкенда + фронтенд поля (isActive, appearedAt, disappearedAt)
    const [opportunitiesMap, setOpportunitiesMap] = useState(new Map());

    // monitoredData - список бирж/пар из конфига бэкенда (для модалки фильтров и MonitoredList)
    const [monitoredData, setMonitoredData] = useState({});

    // exchangeStatuses - статус подключения каждой биржи (для MonitoredList или отдельного индикатора)
    const [exchangeStatuses, setExchangeStatuses] = useState({}); // Получаем polling'ом

    // Loading теперь показывает, идет ли ПЕРВАЯ загрузка данных возможностей по WS
    // Устанавливаем true при переходе на страницу arbitrage_cex, если map пустая.
    // Устанавливаем false при получении ПЕРВОГО сообщения с данными.
    const [loading, setLoading] = useState(false);
    // Общая ошибка приложения (например, при WS соединении, обработке данных, загрузке конфига/статуса)
    const [error, setError] = useState(null);
    // Статус WS: 'connecting', 'connected', 'disconnected', 'error' (для индикатора)
    const [wsStatus, setWsStatus] = useState('disconnected');

    // State для сортировки
    const [sortConfig, setSortConfig] = useState(() => {
         const savedSort = localStorage.getItem('sortConfig');
         // По умолчанию сортируем по net_profit (чистой прибыли) по убыванию
         return savedSort ? JSON.parse(savedSort) : { key: 'net_profit', direction: 'descending' };
    });

    // State для поколоночных фильтров
    const [columnFilters, setColumnFilters] = useState(() => {
         const savedFilters = localStorage.getItem('columnFilters');
         // Поля для фильтрации по умолчанию
         return savedFilters ? JSON.parse(savedFilters) : {
             buy_exchange: '', sell_exchange: '', symbol: '', networks: ''
         };
    });

    // State для фильтров из модального окна
    const [exchangeFilters, setExchangeFilters] = useState(() => {
        const saved = localStorage.getItem('exchangeFilters');
        return saved ? JSON.parse(saved) : [];
    });
    const [cryptoFilters, setCryptoFilters] = useState(() => {
        const saved = localStorage.getItem('cryptoFilters');
        return saved ? JSON.parse(saved) : [];
    });
    const [showFilterModal, setShowFilterModal] = useState(false); // Видимость модалки фильтров

    // State для общего текстового фильтра (Search)
     const [filterText, setFilterText] = useState(() => {
         const savedSearch = localStorage.getItem('filterText');
         return savedSearch ? savedSearch : '';
     });

    // State для пагинации
    const [rowsPerPage, setRowsPerPage] = useState(() => {
        const savedRowsPerPage = localStorage.getItem('rowsPerPage');
        return savedRowsPerPage ? Number(savedRowsPerPage) : 10;
    });
    // Всегда начинаем с первой страницы при загрузке/фильтрации/сортировке/смене rowsPerPage
    const [currentPage, setCurrentPage] = useState(1);

    // State для выбранной возможности (для окна деталей)
    const [selectedOpportunity, setSelectedOpportunity] = useState(null);

    // State для активной страницы/вида
    const [activePage, setActivePage] = useState(() => {
        const savedPage = localStorage.getItem('activePage');
         // Если сохранена страница, но это не arbitrage_cex или monitored, возвращаем home
        if (savedPage && ['arbitrage_cex', 'monitored'].includes(savedPage)) {
            return savedPage;
        }
        return 'home';
    });

    // State для обновления "времени с обновления" в таблице (для визуального счетчика)
    // Этот счетчик просто принуждает перерисовку компонентов, использующих Date.now() или formatTimeSince
    const [updateTimeCounter, setUpdateTimeCounter] = useState(0);

    // State для темы
    const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');

    // --- State для пользовательских настроек комиссий и инвестиций (для ЛОКАЛЬНОГО калькулятора) ---
    const [userBuyCommissionPct, setUserBuyCommissionPct] = useState(() => {
        const saved = localStorage.getItem('userBuyCommissionPct');
        return saved !== null ? Number(saved) : INITIAL_BUY_COMMISSION_PCT;
    });
     const [userSellCommissionPct, setUserSellCommissionPct] = useState(() => {
        const saved = localStorage.getItem('userSellCommissionPct');
        return saved !== null ? Number(saved) : INITIAL_SELL_COMMISSION_PCT;
    });
     const [userInvestmentAmount, setUserInvestmentAmount] = useState(() => {
        const saved = localStorage.getItem('userInvestmentAmount');
        return saved !== null ? Number(saved) : INITIAL_CALC_INVESTMENT_AMOUNT;
    });

    // State для видимости модального окна настроек
    const [showSettingsModal, setShowSettingsModal] = useState(false);

     // Ref для хранения экземпляра WebSocket
     const wsRef = useRef(null);
     // Ref для отслеживания, активно ли сейчас автоматическое переподключение
     const reconnectTimeoutRef = useRef(null);
     // Ref для экспоненциального отката задержки переподключения
     const currentReconnectDelayRef = useRef(WS_RECONNECT_DELAY_MS);


    // --- ФУНКЦИИ-УТИЛИТЫ КОМПОНЕНТА (использующие useCallback) ---

    // Callback для сортировки (обновляет sortConfig state)
    // Принимает ключ колонки для сортировки
    const requestSort = useCallback((key) => {
        setSortConfig(prevSortConfig => {
            let direction = 'ascending';
            // Если уже сортируем по этому ключу и направление 'ascending', меняем на 'descending'
            if (prevSortConfig?.key === key && prevSortConfig.direction === 'ascending') {
                direction = 'descending';
            }
            // При любой смене сортировки, сбрасываем страницу на 1
            // setCurrentPage(1); // Сброс страницы теперь в отдельном useEffect
            return { key, direction };
        });
    }, []); // Нет внешних зависимостей, т.к. setSortConfig всегда актуален

    // Callback для поколоночных фильтров (обновляет columnFilters state)
    // Принимает ключ колонки и новое значение фильтра
    const onColumnFilterChange = useCallback((key, value) => {
        setColumnFilters(prev => ({
            ...prev,
            [key]: value
        }));
        // При любой смене фильтра, сбрасываем страницу на 1
        // setCurrentPage(1); // Сброс страницы теперь в отдельном useEffect
    }, []); // Нет внешних зависимостей

    // Callback для клика по строке таблицы (открывает окно деталей)
    // Принимает объект возможности
    const onRowClick = useCallback((opportunity) => {
        setSelectedOpportunity(opportunity);
    }, []); // Нет внешних зависимостей

    // Callback для закрытия окна деталей
    const onCloseDetails = useCallback(() => {
        setSelectedOpportunity(null);
    }, []);

    // Callback для очистки старых "исчезнувших" возможностей (сборщик мусора)
    const cleanupOpportunities = useCallback(() => {
        setOpportunitiesMap(prevMap => {
            const newMap = new Map(); // Начинаем с пустой Map для новых активных + липких
            let opportunitiesRemovedCount = 0;
            const currentTime = Date.now();

            // Проходимся по всем элементам в Map, оставляем только те, которые должны быть видны
             prevMap.forEach((opp, id) => {
                 // Оставляем активные возможности ИЛИ
                 // неактивные возможности, которые еще не убрал сборщик мусора
                 if (opp.isActive || (opp.disappearedAt && (currentTime - opp.disappearedAt) <= STICKY_DURATION_MS)) {
                      newMap.set(id, opp); // Копируем возможность в новую Map
                 } else {
                      // Эта возможность должна быть удалена
                      opportunitiesRemovedCount++;
                     // console.log(`Opportunity garbage collected: ${id}`);
                 }
             });

            // Возвращаем новую Map только если что-то было удалено или добавлено/изменено в процессе получения данных
            // (но добавление/изменение происходит в обработчике WS)
            // Эта функция только удаляет старые.
            if (opportunitiesRemovedCount > 0) {
                 console.log(`GC: Removed ${opportunitiesRemovedCount} stale opportunities. New Map size: ${newMap.size}`);
                return newMap; // Возвращаем новую Map
            }
            // Если ничего не изменилось, возвращаем старую Map для оптимизации React
            return prevMap;
        });
    }, [STICKY_DURATION_MS]); // Зависит от константы STICKY_DURATION_MS

    // --- КОНЕЦ ФУНКЦИЙ-УТИЛИТ КОМПОНЕНТА ---


    // --- useMemo для фильтрации, сортировки, пагинации ---
    // 1. Преобразование Map в Array и применение всех фильтров
     const filteredOpportunities = useMemo(() => {
         // console.log("Calculating filteredOpportunities...");
         let items = Array.from(opportunitiesMap.values()); // Начинаем с массива всех возможностей из Map

         // Filter Step 1: Remove truly stale opportunities (this happens in cleanupOpportunities)
         // The opportunitiesMap only contains active or "sticky" opportunities already.

         // Модальные фильтры (Биржи)
         if (exchangeFilters.length > 0) {
             items = items.filter(opp =>
                 // Фильтруем по биржам покупки ИЛИ продажи (любая из них должна быть в списке фильтров)
                 exchangeFilters.includes(opp.buy_exchange?.toLowerCase()) ||
                 exchangeFilters.includes(opp.sell_exchange?.toLowerCase())
             );
         }

         // Модальные фильтры (Криптовалюты)
         if (cryptoFilters.length > 0) {
             items = items.filter(opp => {
                 const baseCrypto = opp.symbol?.split('/')[0]; // Берем базовую валюту из символа
                 return baseCrypto && cryptoFilters.includes(baseCrypto.toLowerCase()); // Приводим к нижнему регистру для сравнения
             });
         }

         // Общий текстовый фильтр (Поиск по символу, биржам)
         if (filterText) {
             const lowerCaseFilter = filterText.toLowerCase();
             items = items.filter(opp =>
                 // Проверяем, содержит ли любая из этих строк текст фильтра
                 String(opp.symbol ?? '').toLowerCase().includes(lowerCaseFilter) ||
                 String(opp.buy_exchange ?? '').toLowerCase().includes(lowerCaseFilter) ||
                 String(opp.sell_exchange ?? '').toLowerCase().includes(lowerCaseFilter)
             );
         }

         // Поколоночные фильтры (для строковых полей)
          const filterableKeys = ['buy_exchange', 'sell_exchange', 'symbol', 'networks'];
          filterableKeys.forEach(key => {
              const filterValue = columnFilters[key]?.toLowerCase();
              if (filterValue) {
                  items = items.filter(item => {
                      const itemValue = item[key];
                       // Если значение поля null/undefined, оно не соответствует непустому фильтру
                      if (itemValue === null || itemValue === undefined) return false;

                      // Специальная обработка для 'networks' - фильтруем по обоим полям network
                      if (key === 'networks') {
                           const buyNetwork = item.buy_network ?? '';
                           const sellNetwork = item.sell_network ?? '';
                           // Соответствует, если текст фильтра есть в buy_network ИЛИ sell_network
                           return buyNetwork.toLowerCase().includes(filterValue) || sellNetwork.toLowerCase().includes(filterValue);
                       }
                      // Стандартная фильтрация для других строковых полей
                      return String(itemValue).toLowerCase().includes(filterValue);
                  });
              }
          });

         // TODO: Добавить поколоночные фильтры для числовых полей (мин/макс прибыль, объем)

         return items;

     }, [opportunitiesMap, exchangeFilters, cryptoFilters, filterText, columnFilters, updateTimeCounter]); // Зависимости от всех фильтров И от updateTimeCounter для обновления времени с исчезновения


     // 2. Сортировка отфильтрованного массива
     const sortedOpportunities = useMemo(() => {
         // console.log("Calculating sortedOpportunities...");
         let sortableItems = [...filteredOpportunities]; // Сортируем отфильтрованные данные

         if (sortConfig.key) {
             sortableItems.sort((a, b) => {
                 // Специальная сортировка: активные возможности всегда выше неактивных
                 // (Если сортируем не по времени с обновления, т.к. там своя логика)
                 if (sortConfig.key !== 'time_since_update') {
                    if (a.isActive && !b.isActive) return -1; // Активные выше
                    if (!a.isActive && b.isActive) return 1; // Неактивные ниже
                 }

                 // Получаем значения для сортировки
                 // Для 'net_profit' используем net_profit_pct с бэкенда
                 const aValue = sortConfig.key === 'net_profit' ? a.net_profit_pct : a[sortConfig.key];
                 const bValue = sortConfig.key === 'net_profit' ? b.net_profit_pct : b[sortConfig.key];

                 // Улучшенная обработка null/undefined при сортировке: null/undefined в конец при ascending, в начало при descending
                 // null/undefined считаются "меньшими" чем числа/строки.
                 if (aValue == null && bValue == null) return 0; // Оба null/undefined -> равны
                 if (aValue == null) return sortConfig.direction === 'ascending' ? 1 : -1; // a null -> a больше b (в ascending), a меньше b (в descending)
                 if (bValue == null) return sortConfig.direction === 'ascending' ? -1 : 1; // b null -> b больше a (в ascending), b меньше b (в descending)


                 // Сортировка чисел (для net_profit, executable_volume_base, fees_paid_quote, timestamp, potential_profit_pct и т.д.)
                 // Используем явный список числовых полей, включая 'net_profit' (который сортируется по % полю)
                 const numericKeys = [
                     'potential_profit_pct', 'net_profit', 'executable_volume_base',
                     'fees_paid_quote', 'timestamp' // timestamp с бэкенда в ms
                 ];
                 if (numericKeys.includes(sortConfig.key)) {
                     // Убедимся, что значения действительно числа, иначе падаем в строковое сравнение как резерв
                     const numA = Number(aValue);
                     const numB = Number(bValue);
                     if (!isNaN(numA) && !isNaN(numB)) {
                        return sortConfig.direction === 'ascending' ? numA - numB : numB - numA;
                     }
                      // Если не числа, сортируем как строки (резервный вариант) - используем обычное сравнение ниже
                 }

                 // Сортировка по времени с обновления (чем меньше, тем свежее = выше при descending)
                 if (sortConfig.key === 'time_since_update') {
                     // Для сортировки по времени с обновления, используем время исчезновения для неактивных
                     // и время timestamp для активных. Все в миллисекундах.
                     const timeA = a.disappearedAt ? a.disappearedAt : (a.timestamp ?? 0); // Используем timestamp из бэкенда (в ms)
                     const timeB = b.disappearedAt ? b.disappearedAt : (b.timestamp ?? 0); // Используем timestamp из бэкенда (in ms)

                      // Обработка null/undefined для времени (уже сделана выше)

                     const diffA = Date.now() - timeA; // Разница в миллисекундах
                     const diffB = Date.now() - timeB;

                     // Сортируем по разнице времени. При 'ascending', хотим видеть старые сверху (большая разница) -> diffB - diffA.
                     // При 'descending', хотим видеть свежие сверху (меньшая разница) -> diffA - diffB.
                     // Это обратная сортировка по разнице времени.
                     return sortConfig.direction === 'ascending' ? diffB - diffA : diffA - diffB;
                 }

                 // Сортировка строк (по умолчанию, регистронезависимая)
                 const stringA = String(aValue).toLowerCase();
                 const stringB = String(bValue).toLowerCase();
                 if (stringA < stringB) return sortConfig.direction === 'ascending' ? -1 : 1;
                 if (stringA > stringB) return sortConfig.direction === 'ascending' ? 1 : -1;

                 return 0; // Значения равны
             });
         }
         return sortableItems;
     }, [filteredOpportunities, sortConfig, updateTimeCounter]); // Зависит от отфильтрованных данных, конфигурации сортировки и updateTimeCounter


    // 3. Пагинация отсортированного массива
    const paginatedOpportunities = useMemo(() => {
         // console.log("Calculating paginatedOpportunities...");
        const startIndex = (currentPage - 1) * rowsPerPage;
        const endIndex = startIndex + rowsPerPage;
        return sortedOpportunities.slice(startIndex, endIndex);
    }, [sortedOpportunities, currentPage, rowsPerPage]); // Зависит от отсортированных данных и настроек пагинации

     const totalFilteredCount = filteredOpportunities.length; // Общее количество строк после всех фильтров
     // Убедимся, что rowsPerPage > 0 для расчета totalPages, избегаем деления на ноль
     const totalPages = Math.max(1, Math.ceil(totalFilteredCount / (rowsPerPage > 0 ? rowsPerPage : 1))); // Минимум 1 страница


     // --- КОНЕЦ useMemo для фильтрации, сортировки, пагинации ---


    // --- Эффекты ---

    // Эффект для сохранения темы в localStorage И применения класса к body
    useEffect(() => {
        localStorage.setItem('theme', theme);
        // Применяем класс темы к тегу body
        document.body.className = theme + '-theme';
    }, [theme]);

     // Эффекты для сохранения пользовательских настроек комиссий и инвестиций в localStorage
     // Эти настройки используются только в локальном калькуляторе модалки деталей
     useEffect(() => {
         localStorage.setItem('userBuyCommissionPct', userBuyCommissionPct);
     }, [userBuyCommissionPct]);

      useEffect(() => {
         localStorage.setItem('userSellCommissionPct', userSellCommissionPct);
     }, [userSellCommissionPct]);

       useEffect(() => {
         localStorage.setItem('userInvestmentAmount', userInvestmentAmount);
     }, [userInvestmentAmount]);


    // Эффект для обновления счетчика времени (каждую секунду) для "времени с обновления"
     useEffect(() => {
         // Запускаем счетчик только если активна страница арбитража или мониторинга, где отображается время
         if (activePage === 'arbitrage_cex' || activePage === 'monitored') {
              console.log("App: Starting time counter interval.");
             const intervalId = setInterval(() => {
                 // console.log("Updating time counter..."); // Отладка
                 setUpdateTimeCounter(prev => prev + 1);
             }, 1000); // Обновляем каждую секунду
             return () => {
                  console.log("App: Cleaning up time counter interval.");
                 clearInterval(intervalId);
             };
         }
          // Очищаем интервал при уходе со страниц, где время не отображается динамически
         console.log("App: activePage not arbitrage_cex or monitored, time counter stopped.");
         return () => {}; // Возвращаем пустую функцию очистки

     }, [activePage]); // Зависит от активной страницы

     // Эффект для сохранения сортировки в localStorage
     useEffect(() => {
         localStorage.setItem('sortConfig', JSON.stringify(sortConfig));
     }, [sortConfig]);

     // Эффект для сохранения поколоночных фильтров в localStorage
      useEffect(() => {
          localStorage.setItem('columnFilters', JSON.stringify(columnFilters));
      }, [columnFilters]);

      // Эффект для сохранения общего фильтра (поиск) в localStorage
      useEffect(() => {
          localStorage.setItem('filterText', filterText);
      }, [filterText]);


    // Эффект для сохранения активной страницы в localStorage
     useEffect(() => {
         console.log(`App: Active page changed to: ${activePage}`);
         localStorage.setItem('activePage', activePage);
         // При смене страницы, закрываем окно деталей
         setSelectedOpportunity(null);

         // При смене страницы на arbitrage_cex, устанавливаем loading = true, если данных еще нет
         if (activePage === 'arbitrage_cex' && opportunitiesMap.size === 0) {
             setLoading(true);
              console.log("App: Switching to arbitrage_cex with no data, setting loading TRUE.");
         } else {
              // При уходе со страницы arbitrage_cex, сбрасываем loading и ошибку WS
              if (activePage !== 'arbitrage_cex') {
                   setLoading(false);
                   // Ошибку WS очищаем только при успешном подключении/сообщении
                   // error state может содержать и другие ошибки, кроме WS
                   // Пока оставим ошибку видимой до след.успеха
              }
         }
         // WS подключение/отключение управляется в отдельном эффекте ниже.

     }, [activePage, opportunitiesMap.size]); // Зависит от activePage и размера map (для loading)

     // Эффект для сохранения фильтров модального окна в localStorage
     useEffect(() => {
        localStorage.setItem('exchangeFilters', JSON.stringify(exchangeFilters));
     }, [exchangeFilters]);

    useEffect(() => {
        localStorage.setItem('cryptoFilters', JSON.stringify(cryptoFilters));
    }, [cryptoFilters]);

    // Эффект для сохранения строк на страницу в localStorage
    useEffect(() => {
        localStorage.setItem('rowsPerPage', rowsPerPage);
        // При изменении rowsPerPage, сбрасываем страницу на 1.
        // setCurrentPage(1); // Сброс страницы теперь в отдельном эффекте ниже
     }, [rowsPerPage]);

    // Эффект для сброса страницы на 1 при изменении фильтров, сортировки или rowsPerPage
     useEffect(() => {
         // При изменении любого фильтра (текстовый, поколоночный, модальный), сортировки
         // или количества строк на странице, сбрасываем страницу на 1.
         // Это гарантирует, что пользователь всегда увидит начало нового отфильтрованного/отсортированного списка.
         console.log("App: Resetting page to 1 due to filter/sort/rowsPerPage change.");
         setCurrentPage(1);
     }, [filterText, columnFilters, exchangeFilters, cryptoFilters, sortConfig, rowsPerPage]); // Зависит от всех состояний, влияющих на список и его отображение

     // Эффект для очистки старых возможностей (сборщик мусора) - запускается периодически
     useEffect(() => {
          console.log(`App: GC: Starting interval. Cleanup every ${GC_INTERVAL_MS / 1000} seconds.`);
         const gcInterval = setInterval(cleanupOpportunities, GC_INTERVAL_MS);

         return () => {
              console.log("App: GC: Cleaning up interval.");
              clearInterval(gcInterval);
         };
     }, [cleanupOpportunities]); // Зависит от useCallback cleanupOpportunities


    // --- Эффект для WS подключения и обработки сообщений ---
    useEffect(() => {
        let isMounted = true; // Флаг для проверки, смонтирован ли компонент
        // wsRef.current = null; // Убедимся, что ref пустой при старте эффекта эффекта (но лучше его не трогать тут)

        const connect = () => {
            if (!isMounted) {
                 console.log("App WS: Connect attempt aborted, component unmounted.");
                 return; // Не подключаемся, если компонент размонтирован
            }
            // Проверяем текущее состояние wsRef.current, чтобы избежать лишних подключений
            if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
                 console.log("App WS: Connection already open or connecting. Skipping connect attempt.");
                 return; // Не подключаемся, если уже подключены или в процессе
            }

            console.log(`App WS: Attempting to connect to ${WS_URL}`);
            setWsStatus('connecting');
            // Loading установлен в эффекте смены страницы, если нужно.
            // Очищаем предыдущую ошибку WS перед попыткой подключения
             setError(null); // Очищаем общую ошибку

            const ws = new WebSocket(WS_URL); // Создаем новый экземпляр WebSocket
            wsRef.current = ws; // Сохраняем в ref для доступа из cleanup и других обработчиков


            ws.onopen = () => {
                console.log('App WS: Connected.');
                setWsStatus('connected');
                setError(null); // Очищаем общую ошибку при успешном подключении
                // Loading = false устанавливается при получении первого сообщения onmessage
                // Сбрасываем задержку и таймаут переподключения при успешном соединении
                 currentReconnectDelayRef.current = WS_RECONNECT_DELAY_MS; // Сбрасываем задержку к начальной
                 if (reconnectTimeoutRef.current) {
                     clearTimeout(reconnectTimeoutRef.current);
                     reconnectTimeoutRef.current = null;
                 }
            };

            ws.onmessage = (event) => {
                // console.log('App WS: Message received:', event.data);
                if (!isMounted) {
                     console.log("App WS: Message received after unmount, skipping.");
                     return; // Игнорируем сообщения после размонтирования
                }
                try {
                    // Парсим JSON-строку, ожидаем список возможностей (ArbitrageOpportunity[])
                    const incomingOpportunitiesList = JSON.parse(event.data);

                    // Проверяем, что полученные данные - это массив
                    if (Array.isArray(incomingOpportunitiesList)) {
                         const currentTime = Date.now(); // Текущее время для меток appearedAt/disappearedAt

                         // Создаем Map из входящих данных по их НОВОМУ СТАБИЛЬНОМУ ID с бэкенда
                         const incomingMap = new Map();
                         for (const incomingOpp of incomingOpportunitiesList) {
                              // Проверяем, что у входящего объекта есть id
                             if (incomingOpp && typeof incomingOpp.id === 'string') {
                                  // Дополнительная проверка, что объект содержит ожидаемые поля (опционально)
                                  if (typeof incomingOpp.symbol === 'string' && typeof incomingOpp.buy_exchange === 'string' && typeof incomingOpp.sell_exchange === 'string' && typeof incomingOpp.net_profit_pct === 'number') {
                                      incomingMap.set(incomingOpp.id, incomingOpp);
                                  } else {
                                       console.warn("App WS: Received opportunity with invalid structure, skipping:", incomingOpp);
                                  }
                             } else {
                                  console.warn("App WS: Received opportunity without a valid ID, skipping:", incomingOpp);
                                  // Пропускаем возможности без ID, т.к. они не могут быть надежно отслежены.
                             }
                         }

                         // Обновляем opportunitiesMap на основе входящих данных (immutable update)
                         setOpportunitiesMap(prevMap => {
                             const newMap = new Map(); // Создаем новую Map

                             // Шаг 1: Копируем все из предыдущей Map в новую Map
                             // (Включает старые активные и "липкие" неактивные)
                              prevMap.forEach((opp, id) => {
                                  newMap.set(id, opp); // Копируем старую возможность
                              });

                              let opportunitiesAddedCount = 0;
                              let opportunitiesUpdatedCount = 0;
                              let opportunitiesDisappearedCount = 0;


                             // Шаг 2: Проходим по ВХОДЯЩИМ данным
                             incomingMap.forEach((incomingOpp, id) => {
                                  const existingOpp = newMap.get(id); // Ищем в новой (скопированной) Map

                                  if (!existingOpp) {
                                      // Это совершенно новая возможность (не было ни в старой Map, ни, следовательно, в новой скопированной). Добавляем ее.
                                     newMap.set(id, {
                                         ...incomingOpp, // Все поля из входящей возможности
                                         isActive: true, // Помечаем как активную
                                         appearedAt: currentTime, // Устанавливаем время первого появления
                                         disappearedAt: undefined, // Не исчезла
                                     });
                                     opportunitiesAddedCount++;
                                     // console.log(`App WS: New opportunity appeared: ${id}`);
                                  } else {
                                      // Возможность уже существует в Map (была активна или "липкая").
                                      // Сравниваем *сырые* данные (поля с бэкенда) с данными, которые были в prevMap.
                                      // Если данные изменились, обновляем запись.
                                      // Важно сравнивать входящие с ТЕКУЩИМИ данными в existingOpp (которое было скопировано из prevMap).
                                      if (!areOpportunitiesEqual(existingOpp, incomingOpp)) {
                                          // Сырые данные ИЗМЕНИЛИСЬ - это "обновление" возможности
                                          // Обновляем запись в newMap.
                                          newMap.set(id, {
                                              ...incomingOpp, // Новые данные с бэкенда (включая новый timestamp)
                                              isActive: true, // Снова активна
                                              appearedAt: existingOpp.appearedAt, // Сохраняем время первого появления
                                              disappearedAt: undefined, // Активная, значит не исчезла
                                          });
                                           opportunitiesUpdatedCount++;
                                          // console.log(`App WS: Opportunity data changed: ${id}. Updating.`);
                                      } else {
                                           // Сырые данные НЕ изменились. Убедимся, что она помечена как активная.
                                           // Если она была неактивна ("липкая") и появилась снова без изменения данных,
                                           // это может быть странно, но помечаем как активную.
                                           // Если она была активна, оставляем активной.
                                           if (!existingOpp.isActive) {
                                                newMap.set(id, {
                                                    ...existingOpp,
                                                    isActive: true,
                                                    disappearedAt: undefined,
                                                });
                                                opportunitiesUpdatedCount++; // Считаем как обновление статуса
                                                // console.log(`App WS: Opportunity reappeared without data change: ${id}. Marking active.`);
                                           }
                                           // Если active и данные не изменились, просто оставляем ее в newMap (уже скопирована на шаге 1)
                                      }
                                  }
                             });

                            // Шаг 3: Проходим по ВСЕМ записям в *новой* Map
                            // Те возможности, которые были в старой Map (и теперь в новой), но НЕ попали во входящий incomingMap
                            // (т.е. не были добавлены или обновлены в шаге 2), помечаем как неактивные, если они были активны.
                             Array.from(newMap.keys()).forEach(id => {
                                 const opp = newMap.get(id);
                                 // Если возможность активна (на основе предыдущего состояния или если ее статус только что обновился в шаге 2)
                                 // И она не была включена в incomingMap из текущего фида
                                  if (opp && opp.isActive && !incomingMap.has(id)) {
                                       // Помечаем как неактивную, если она не была во входящем фиде
                                       // Но только если она не была только что добавлена в шаге 2 (проверка на incomingMap.has(id) уже это гарантирует)
                                       newMap.set(id, {
                                           ...opp,
                                           isActive: false,
                                           disappearedAt: currentTime, // Устанавливаем время исчезновения
                                       });
                                       opportunitiesDisappearedCount++;
                                       // console.log(`App WS: Opportunity disappeared: ${id}`);
                                  }
                             });


                             // Устанавливаем loading = false после получения первого сообщения, если он был true
                             if (loading) { // Проверяем текущее состояние loading
                                 console.log("App WS: Received first data message, setting loading FALSE.");
                                 setLoading(false);
                             }


                             // Возвращаем обновленную Map. React сравнит newMap и prevMap и обновит состояние,
                             // если Map изменилась (добавление/удаление ключей, изменение значений).
                              console.log(`App WS: Opportunities update. Added: ${opportunitiesAddedCount}, Updated: ${opportunitiesUpdatedCount}, Disappeared: ${opportunitiesDisappearedCount}. Total active+sticky in Map: ${newMap.size}`); // Отладка
                             return newMap;
                         });


                         setError(null); // Очищаем общую ошибку, если данные успешно получены и обработаны

                    } else {
                        // Если формат данных некорректен (не массив)
                        console.error("App WS: Received data is not an array:", event.data);
                        // Устанавливаем общую ошибку
                         setError("Получены некорректные данные по WebSocket.");
                         // Не меняем loading, т.к. это не ошибка соединения, а ошибка формата данных.
                    }
                } catch (e) {
                    // Ошибка парсинга JSON или обновления состояния React
                    console.error("App WS: Failed to process message or update state:", e);
                     // Устанавливаем общую ошибку
                    setError("Ошибка обработки данных по WebSocket.");
                     // Не меняем loading.
                }
            };

            ws.onerror = (event) => {
                console.error('App WS: Error:', event);
                setWsStatus('error');
                // Ошибка соединения. onclose будет вызван после onerror.
                // Основная логика переподключения будет в onclose.
            };

            ws.onclose = (event) => {
                console.log('App WS: Disconnected:', event.code, event.reason);
                 setWsStatus('disconnected');
                 // Устанавливаем общую ошибку, только если отключение не было чистым (код 1000)
                 // и если мы на странице арбитража, где ожидается WS
                 if (event.code !== 1000 && activePage === 'arbitrage_cex') {
                     // Ошибка, если код отключения не 1000 (нормальное завершение)
                     setError(`Соединение по WebSocket потеряно (код: ${event.code}).`);
                 } else {
                      // Чистое отключение (код 1000) или ушли со страницы - сбрасываем ошибку, связанную с WS соединением
                      // Но не сбрасываем ошибки, связанные с форматом данных.
                      // TODO: Дифференцировать типы ошибок, чтобы не сбросить ошибку данных при чистом закрытии WS.
                      // Пока сбрасываем все ошибки при чистом закрытии (код 1000) или уходе со страницы.
                      if (event.code === 1000 || activePage !== 'arbitrage_cex') {
                           setError(null);
                      }
                 }

                // Если компонент все еще смонтирован И мы на странице CEX арбитража,
                // И отключение не было чистым (код 1000), пытаемся переподключиться.
                if (isMounted && activePage === 'arbitrage_cex' && event.code !== 1000) {
                    console.log("App WS: Unexpected disconnection, attempting reconnect...");
                    scheduleReconnect(); // Запускаем переподключение
                } else {
                     console.log("App WS: Clean disconnection or page changed, no reconnect.");
                      // При чистом отключении (код 1000) или смене страницы не переподключаемся автоматически
                      // Убедимся, что таймаут переподключения отменен, если он был запланирован ранее
                       if (reconnectTimeoutRef.current) {
                           clearTimeout(reconnectTimeoutRef.current);
                           reconnectTimeoutRef.current = null;
                       }
                       // Сбрасываем задержку переподключения на начальную при чистом закрытии
                       currentReconnectDelayRef.current = WS_RECONNECT_DELAY_MS;
                }
                 // Очищаем ref после закрытия, чтобы позволить следующему connect создать новый экземпляр
                 wsRef.current = null;

            };
        }; // Конец функции connect

        const scheduleReconnect = () => {
             // Если мы уже запланировали переподключение, не делаем это снова
            if (reconnectTimeoutRef.current) {
                 console.log("App WS: Reconnect already scheduled.");
                 return;
            }

            console.log(`App WS: Scheduling reconnect in ${currentReconnectDelayRef.current / 1000} seconds...`);
            // Устанавливаем статус перед таймаутом (может уже быть установлен в onclose)
            // setWsStatus(error ? 'error' : 'disconnected'); // Этот статус уже ставится в onclose

            const timeoutId = setTimeout(() => {
                 reconnectTimeoutRef.current = null; // Сбрасываем ref перед попыткой
                 // Проверяем isMounted И активную страницу перед *попыткой* переподключения
                 if (isMounted && activePage === 'arbitrage_cex') {
                      console.log("App WS: Attempting scheduled reconnect...");
                     connect(); // Попытка переподключения
                 } else {
                     console.log("App WS: Scheduled reconnect canceled (component unmounted or page changed).");
                      // Если переподключение отменено, сбрасываем задержку на начальную для будущих подключений
                       currentReconnectDelayRef.current = WS_RECONNECT_DELAY_MS;
                 }
            }, currentReconnectDelayRef.current);

            // Увеличиваем задержку для следующей попытки (экспоненциальный откат с ограничением)
            currentReconnectDelayRef.current = Math.min(currentReconnectDelayRef.current * 2, MAX_WS_RECONNECT_DELAY_MS);

             reconnectTimeoutRef.current = timeoutId; // Сохраняем таймаут в ref
        };

        const closeWs = () => {
             isMounted = false; // Устанавливаем флаг монтирования в false перед закрытием
            if (wsRef.current) {
                 console.log("App WS: Closing connection...");
                 // Убираем все обработчики перед закрытием, чтобы избежать нежелательных действий
                 // в случае, если onclose уже был вызван по другой причине
                 const currentWs = wsRef.current;
                 currentWs.onopen = null;
                 currentWs.onmessage = null;
                 currentWs.onerror = null;
                 currentWs.onclose = null; // Важно: убираем наш onclose, чтобы он не вызвал scheduleReconnect
                 // Закрываем соединение с кодом 1000 (нормальное завершение)
                 // Проверяем readyState перед вызовом close
                 if (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING) {
                     currentWs.close(1000, 'Component cleanup');
                 }
                 wsRef.current = null; // Сбрасываем ref
            }
             // Также отменяем любой запланированный таймаут переподключения
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            // Принудительно ставим статус 'disconnected' при очистке
             setWsStatus('disconnected');
             // Сбрасываем задержку переподключения на начальную
             currentReconnectDelayRef.current = WS_RECONNECT_DELAY_MS;

             // Не очищаем opportunitiesMap полностью здесь, чтобы сохранить липкие возможности
             // setOpportunitiesMap(new Map()); // Не очищаем тут

             // Не сбрасываем error тут, чтобы он оставался виден до следующего connect/onopen
        };


        // --- Основная логика эффекта ---
        // Запускаем подключение WS только когда активна страница arbitrage_cex
        if (activePage === 'arbitrage_cex') {
            console.log("App WS Effect: activePage is arbitrage_cex. Starting connection.");
             isMounted = true; // Устанавливаем флаг монтирования в true для этого эффекта
             connect(); // Первый вызов connect

             // Функция очистки: выполняется при уходе со страницы или размонтировании компонента App
             return () => {
                 console.log("App WS Effect Cleanup: activePage changed or component unmounting. Closing connection.");
                 isMounted = false; // Устанавливаем флаг монтирования в false
                 closeWs(); // Закрываем WS соединение и отменяем таймаут переподключения
                 // Интервал сборщика мусора очищается в отдельном useEffect.
             };

        } else {
            // При уходе со страницы, закрываем WS соединение, если оно было открыто на этой странице.
            // Cleanup функция из предыдущего вызова эффекта (если activePage БЫЛА arbitrage_cex)
            // должна сработать и остановить WS.
             console.log("App WS Effect: activePage is NOT arbitrage_cex. Closing existing connection if open.");
             // Если wsRef.current существует (соединение было открыто на arbitrage_cex)
             if (wsRef.current) {
                 // Вызываем closeWs, чтобы закрыть соединение и отменить переподключение
                 // Это сработает как cleanup из предыдущего эффекта.
                 closeWs();
             }
              // В любом случае, возвращаем пустую функцию очистки для этого случая.
             return () => {
                 console.log("App WS Effect Cleanup: activePage was not arbitrage_cex.");
                 isMounted = false; // Просто на всякий случай
                 // Переподключение уже отменено в closeWs, если оно было активно.
             };
        }

    }, [activePage]); // Зависимости: activePage для старта/остановки WS


    // Эффект для загрузки списка мониторинга (для фильтров в модалке и MonitoredList)
     useEffect(() => {
         // Загружаем данные мониторинга независимо от активной страницы, т.к. они используются в модалке,
         // которая может быть открыта с любой страницы.
         const fetchMonitoredDataForFilters = async () => {
             try {
                 console.log(`App: Fetching monitored data from ${API_URL_MONITORED}...`);
                 const response = await axios.get(API_URL_MONITORED);
                 if (typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)) {
                     setMonitoredData(response.data);
                      console.log("App: Monitored data fetched successfully.");
                 } else {
                     console.error("App: Backend returned invalid format for monitored pairs (for filters):", response.data);
                     // Можно установить состояние ошибки для загрузки мониторинга, если нужно
                     // setError("Ошибка загрузки конфигурации мониторинга.");
                 }
             } catch (err) {
                 console.error("App: Error fetching monitored pairs (for filters):", err);
                 // Можно установить состояние ошибки для загрузки мониторинга
                  // setError(`Ошибка загрузки конфигурации мониторинга: ${err.message}`);
             }
         };

          // Эффект для polling'а статусов бирж
         useEffect(() => {
             let isMounted = true;
             const fetchExchangeStatuses = async () => {
                 if (!isMounted) return;
                 try {
                     console.log(`App: Polling exchange statuses from ${API_URL_STATUS}...`);
                     const response = await axios.get(API_URL_STATUS);
                      if (isMounted) {
                          if (response.data && typeof response.data.exchange_statuses === 'object') {
                              setExchangeStatuses(response.data.exchange_statuses);
                             // console.log("App: Exchange statuses fetched successfully.");
                          } else {
                             console.warn("App: Backend did not return exchange statuses in expected format:", response.data);
                              // setExchangeStatuses({}); // Очищаем или оставляем старые? Оставим старые на случай временных проблем
                          }
                      }
                 } catch (err) {
                     if (isMounted) {
                          console.error("App: Error fetching exchange statuses:", err);
                          // setExchangeStatuses({}); // Очищаем при ошибке, или оставляем старые? Оставим старые.
                         // setError(`Ошибка загрузки статусов бирж: ${err.message}`); // Устанавливаем ошибку приложения
                     }
                 }
             };

             // Первый вызов сразу
             fetchExchangeStatuses();

             // Настраиваем интервал
             const statusPollingIntervalId = setInterval(fetchExchangeStatuses, STATUS_POLLING_INTERVAL_MS);

             // Функция очистки
             return () => {
                  isMounted = false;
                 console.log("App: Cleaning up status polling interval.");
                 clearInterval(statusPollingIntervalId); // Очищаем интервал опроса статуса
             };

         }, []); // Пустой массив зависимостей - эффект выполнится только один раз при монтировании App

         // Запускаем загрузку данных мониторинга (конфигурации) один раз при монтировании App
         fetchMonitoredDataForFilters();

         // Функция очистки для этого внешнего эффекта (загрузка конфига) - не нужна, т.к. одноразово.

     }, []); // Пустой массив зависимостей - эффект выполнится только один раз при монтировании App


    // --- Рендер части ---
    // Функция для переключения темы - уже useCallback
    const toggleTheme = useCallback(() => {
        setTheme(prevTheme => prevTheme === 'light' ? 'dark' : 'light');
    }, []);

    // Функции для пагинации
    const handlePageChange = useCallback((page) => {
        // Убедимся, что номер страницы в пределах допустимого диапазона
        if (page >= 1 && page <= totalPages) {
            setCurrentPage(page);
        } else if (page < 1) {
             setCurrentPage(1);
        } else if (page > totalPages) {
             // Если мы перешли на страницу > totalPages (например, из-за изменения фильтров/объема данных)
             // Переходим на последнюю страницу
             setCurrentPage(totalPages);
        }
    }, [totalPages]); // Зависит от общего количества страниц

    const handleRowsPerPageChange = useCallback((event) => {
        setRowsPerPage(Number(event.target.value));
        // setCurrentPage(1); // Сброс страницы теперь в useEffect по rowsPerPage
    }, []);


     // Определяем, какие данные отображать в таблице (зависит от activePage)
     // На странице CEX Арбитража отображаем пагинированные данные из opportunitiesMap
     const displayOpportunities = activePage === 'arbitrage_cex' ? paginatedOpportunities : [];
     const displayTotalCount = activePage === 'arbitrage_cex' ? totalFilteredCount : 0; // Общее количество для пагинации

     // Определяем, показываем ли оверлей загрузки
     // Показываем, если loading true И мы на странице арбитража, И еще нет данных opportunitiesMap
     const showLoadingOverlay = loading && activePage === 'arbitrage_cex' && opportunitiesMap.size === 0;

    // Определяем, показывать ли сообщения об ошибке загрузки или "нет данных по фильтрам" в OpportunityTable
    // Показываем, если activePage === 'arbitrage_cex' и нет скелетонов
    // Скелетоны определяются в OpportunityTable на основе isLoadingApp и totalFilteredCount === 0
    const showOpportunityTableMessages = activePage === 'arbitrage_cex' && !(loading && opportunitiesMap.size === 0 && !error);


    return (
        // Применяем класс темы к корневому элементу приложения
        <div className={`app-container ${theme}-theme`}>
            {/* Навигация */}
            <nav className="navbar">
                {/* Кнопки навигации */}
                <button onClick={() => setActivePage('home')} className={activePage === 'home' ? 'active' : ''}>Главная</button>
                <button onClick={() => setActivePage('arbitrage_cex')} className={activePage === 'arbitrage_cex' ? 'active' : ''}>CEX Арбитраж</button>
                {/* TODO: Реализовать страницу Мониторинг */}
                <button
                    onClick={() => setActivePage('monitored')}
                    className={activePage === 'monitored' ? 'active' : ''}
                    disabled={!monitoredData || Object.keys(monitoredData).length === 0} // Деактивируем, если нет данных мониторинга
                    title={(!monitoredData || Object.keys(monitoredData).length === 0) ? "Не настроены биржи или пары для мониторинга" : undefined}
                    >
                        Мониторинг
                    </button>
                {/* Кнопки для модалок и темы */}
                 {/* Кнопка Фильтров доступна только на странице CEX Арбитраж */}
                {activePage === 'arbitrage_cex' && (
                     <button onClick={() => setShowFilterModal(true)} aria-label="Открыть модальное окно фильтров">Фильтры</button>
                )}
                <button onClick={() => setShowSettingsModal(true)} aria-label="Открыть модальное окно настроек">Настройки</button>
                <button onClick={toggleTheme} aria-label={`Сменить тему на ${theme === 'light' ? 'Темную' : 'Светлую'}`}>Сменить тему ({theme === 'light' ? 'Светлая' : 'Темная'})</button>

                {/* Статус WS - отображаем только на странице CEX Арбитраж */}
                 {activePage === 'arbitrage_cex' && (
                      <span className={`ws-status status-${wsStatus}`} title={`Статус WebSocket: ${wsStatus}`}>
                          WS: {wsStatus.toUpperCase()}
                      </span>
                 )}

                 {/* Общее сообщение об ошибке приложения в навигации (кратко) */}
                 {error && <span className="app-error" title={`Ошибка: ${error}`}>Ошибка!</span>}
            </nav>

            {/* Основное содержимое */}
            <main className="main-content">
                {/* Оверлей загрузки - отображается, если loading true и мы на странице арбитража без данных */}
                {showLoadingOverlay && (
                    <div className="loading-overlay">Загрузка данных...</div>
                )}
                 {/* TODO: Добавить индикатор загрузки тикеров для MonitoredList (реализован внутри MonitoredList) */}

                 {/* Общее сообщение об ошибке приложения под навигацией (более детально) */}
                 {/* Не показываем здесь, если ошибка уже показана в OpportunityTable */}
                 {error && !showOpportunityTableMessages && (
                      <div className="error-message app-level-error">
                           <p>Ошибка приложения: {error}</p>
                           {/* TODO: Возможно, добавить рекомендации пользователю */}
                       </div>
                 )}


                {activePage === 'home' && (
                    // Передаем onSelectView в HomePage, чтобы кнопки выбора арбитража меняли activePage
                    <HomePage onSelectView={setActivePage} />
                )}

                {activePage === 'arbitrage_cex' && (
                    <>
                         {/* Элементы управления для страницы arbitrage_cex */}
                         <div className="controls"> {/* Используем общий класс .controls */}
                             {/* Общий текстовый фильтр (Поиск) */}
                             <SearchInput
                                 value={filterText}
                                 onChange={setFilterText}
                                 placeholder="Поиск по символу, биржам..."
                             />
                             {/* TODO: Добавить другие элементы управления, специфичные для этой страницы (например, мин/макс прибыль, объем) */}
                         </div>

                         <h2>CEX Арбитраж</h2>

                         {/* Таблица арбитражных возможностей */}
                         {/* Передаем флаг showOpportunityTableMessages для управления отображением сообщений внутри таблицы */}
                        <OpportunityTable
                            opportunities={displayOpportunities} // Пагинированные данные для текущей страницы
                            totalFilteredCount={displayTotalCount} // Общее количество после фильтров (для сообщения "Нет данных")
                            sortConfig={sortConfig} // Конфигурация сортировки
                            requestSort={requestSort} // Callback для сортировки
                            columnFilters={columnFilters} // Текущие значения поколоночных фильтров
                            onColumnFilterChange={onColumnFilterChange} // Callback для изменения поколоночных фильтров
                            onRowClick={onRowClick} // Callback для открытия деталей строки
                            // Пользовательские настройки для локального калькулятора (передаются в Details)
                            userInvestmentAmount={userInvestmentAmount}
                            userBuyCommissionPct={userBuyCommissionPct}
                            userSellCommissionPct={userSellCommissionPct}
                            // Утилиты времени
                            formatTimeSince={formatTimeSince}
                            theme={theme} // Текущая тема
                            // Статусы загрузки/ошибки из App.jsx (для скелетона и общих сообщений)
                            isLoadingApp={loading} // Индикатор загрузки (пока только для первого сообщения)
                            errorApp={error} // Общая ошибка
                            // Данные пагинации (для сообщения "Нет данных на этой странице")
                            currentPage={currentPage}
                            totalPages={totalPages}
                             activePage={activePage} // Передаем активную страницу для условного рендера фильтров в Table
                        />

                        {/* Пагинация - отображаем только если есть отфильтрованные данные */}
                         {displayTotalCount > 0 && (
                             <Pagination
                                 currentPage={currentPage} // Текущая страница
                                 totalPages={totalPages} // Общее количество страниц
                                 totalItems={displayTotalCount} // Общее количество отфильтрованных элементов
                                 itemsPerPage={rowsPerPage} // Строк на странице
                                 onPageChange={handlePageChange} // Callback при смене страницы
                                 onRowsPerPageChange={handleRowsPerPageChange} // Callback при смене строк на страницу
                             />
                         )}
                    </>
                )}

                {activePage === 'monitored' && (
                     <>
                         {/* TODO: Реализовать полноценную страницу Мониторинга */}
                          <h2>Мониторинг бирж и пар</h2>
                           {/* MonitoredList теперь получает тикеры REST polling'ом локально */}
                         <MonitoredList
                             monitoredData={monitoredData} // Передаем данные мониторинга (config)
                             exchangeStatuses={exchangeStatuses} // Передаем exchangeStatuses для индикации статуса бирж
                             theme={theme} // Передаем тему
                             activePage={activePage} // Передаем активную страницу для активации polling
                         />
                     </>
                )}

            </main>

            {/* Модальные окна */}
            {/* Модалка деталей выбранной возможности */}
            {/* Передаем выбранную возможность и пользовательские настройки комиссий/инвестиций */}
            {selectedOpportunity && (
                <OpportunityDetails
                    opportunity={selectedOpportunity} // Выбранная возможность
                    onClose={onCloseDetails} // Функция закрытия
                    // Пользовательские настройки для ЛОКАЛЬНОГО калькулятора в модалке
                    userInvestmentAmount={userInvestmentAmount}
                    userBuyCommissionPct={userBuyCommissionPct} // Передаем, хотя пока не используются в расчете
                    userSellCommissionPct={userSellCommissionPct} // Передаем, хотя пока не используются в расчете
                    theme={theme} // Передаем тему
                />
            )}

            {/* Модалка фильтров */}
            {showFilterModal && (
                 <FilterModal
                     show={showFilterModal} // Состояние видимости
                     onClose={() => setShowFilterModal(false)} // Функция закрытия
                     monitoredData={monitoredData} // Данные для фильтров (список бирж/пар из конфига)
                     exchangeFilters={exchangeFilters} // Выбранные биржи
                     setExchangeFilters={setExchangeFilters} // Установка выбранных бирж
                     cryptoFilters={cryptoFilters} // Выбранные крипты
                     setCryptoFilters={setCryptoFilters} // Установка выбранных крипт
                     theme={theme} // Передаем тему
                 />
            )}

            {/* Модалка настроек */}
            {showSettingsModal && (
                 <SettingsModal
                     show={showSettingsModal} // Состояние видимости
                     onClose={() => setShowSettingsModal(false)} // Функция закрытия
                     // Передаем и функции чтения, и функции записи для пользовательских настроек
                     userBuyCommissionPct={userBuyCommissionPct}
                     setUserBuyCommissionPct={setUserBuyCommissionPct}
                     userSellCommissionPct={userSellCommissionPct}
                     setUserSellCommissionPct={setUserSellCommissionPct}
                     userInvestmentAmount={userInvestmentAmount}
                     setUserInvestmentAmount={setUserInvestmentAmount}
                     theme={theme} // Передаем тему
                 />
            )}

        </div>
    );
}

export default App; // Экспортируем компонент