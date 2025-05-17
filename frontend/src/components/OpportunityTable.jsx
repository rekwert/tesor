// frontend/src/components/OpportunityTable.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './OpportunityTable.css';
// Утилита времени
import { formatTimeSince } from '../utils/timeUtils.js';


// TODO: Перенести логотипы на бэкенд или использовать централизованный источник
// Пока оставим здесь, но учтем, что ключи должны быть в нижнем регистре для соответствия ID бирж с бэкенда.
const exchangeLogos = {
    binance: '/logos/binance.png', // Убедитесь, что пути верны относительно папки public
    coinbase: '/logos/coinbase.png',
    kraken: '/logos/kraken.png',
    bybit: '/logos/bybit.png',
    okx: '/logos/okx.png',
    // добавьте другие логотипы. Важно, чтобы ключи были в нижнем регистре
};


// Принимаем ВСЕ данные для отображения и функции управления из App.jsx:
// opportunities - уже отфильтрованные, отсортированные и пагинированные данные для текущей страницы
// totalFilteredCount - общее количество после фильтров, до пагинации (для сообщения "Нет данных")
// sortConfig, requestSort - для сортировки (информация и колбэк)
// columnFilters, onColumnFilterChange - для поколоночных фильтров (значения и колбэк)
// onRowClick - колбэк для открытия деталей строки
// formatTimeSince - утилита времени
// theme - текущая тема
// isLoadingApp, errorApp - статусы загрузки/ошибки из App.jsx
// currentPage, totalPages - для сообщения о пустой странице пагинации
// activePage - текущая активная страница (для условного отображения фильтров)


function OpportunityTable({
                              opportunities = [], // Уже пагинированные данные для текущей страницы
                              totalFilteredCount = 0, // Общее количество после фильтров (для сообщения "Нет данных")
                              sortConfig, // { key: string | null, direction: 'ascending' | 'descending' }
                              requestSort, // (key: string) => void
                              columnFilters, // { [key: string]: string }
                              onColumnFilterChange, // (key: string, value: string) => void
                              onRowClick, // (opportunity: object) => void
                              formatTimeSince, // (timestamp: number) => string
                              theme, // 'light' | 'dark'
                              isLoadingApp, // boolean (для индикации первой загрузки)
                              errorApp, // string | null (для общей ошибки приложения)
                              currentPage, // number (для пагинации)
                              totalPages, // number (для пагинации)
                              activePage, // Добавим activePage как пропс
                              // userInvestmentAmount, // Больше не нужен здесь, т.к. Net Profit приходит с бэкенда
                              // userBuyCommissionPct, // Больше не нужен здесь
                              // userSellCommissionPct, // Больше не нужен здесь
                          }) {

    // Логи для отладки
    // console.log("OpportunityTable opportunities:", opportunities);
    // console.log("OpportunityTable opportunities.length:", opportunities.length);
    // console.log("OpportunityTable totalFilteredCount:", totalFilteredCount);
    // console.log("OpportunityTable isLoadingApp:", isLoadingApp);
    // console.log("OpportunityTable errorApp:", errorApp);
    // console.log("OpportunityTable currentPage:", currentPage);
    // console.log("OpportunityTable totalPages:", totalPages);
    // console.log("OpportunityTable sortConfig:", sortConfig);
    // console.log("OpportunityTable columnFilters:", columnFilters);


    // --- Состояние для избранных возможностей ---
    // Храним только ID избранных возможностей в localStorage
    const [favorites, setFavorites] = useState(() => {
        const saved = localStorage.getItem('favorites');
        // При загрузке избранного, используем ID, пришедший с бэкенда
        const savedFavorites = saved ? JSON.parse(saved) : [];
        // TODO: Опционально: очищать localStorage от ID, которых больше нет в текущем фиде oportunidadesMap в App.jsx?
        // Это должно происходить в App.jsx при GC или при получении фида. Пока не делаем.
         return savedFavorites;
    });

    // Эффект для сохранения избранного в localStorage при изменении состояния `favorites`
    useEffect(() => {
        // console.log("Saving favorites to localStorage:", favorites); // Отладка
        localStorage.setItem('favorites', JSON.stringify(favorites));
    }, [favorites]); // Зависит от состояния favorites


    // Переключает состояние избранного для возможности по ее ID
    // Принимает объект возможности (чтобы получить opp.id)
    const toggleFavorite = useCallback((opp) => {
        // Используем стабильный ID, пришедший с бэкенда
        const oppId = opp?.id;
        if (!oppId) {
             console.warn("Cannot toggle favorite, opportunity ID is missing:", opp);
             return;
        }

        setFavorites(prev => {
            if (prev.includes(oppId)) {
                console.log(`Removing ${oppId} from favorites.`);
                return prev.filter(id => id !== oppId);
            }
             console.log(`Adding ${oppId} to favorites.`);
            return [...prev, oppId];
        });
    }, []); // Нет внешних зависимостей, т.к. setFavorites всегда актуален


    // Возвращает класс для заголовка колонки для индикации сортировки
    const getSortDirectionClass = useCallback((key) => {
        if (sortConfig?.key !== key) return ''; // Если не сортируем по этому ключу
        return sortConfig.direction === 'ascending' ? 'sort-asc' : 'sort-desc';
    }, [sortConfig]); // Зависит от текущей конфигурации сортировки


    // --- Вспомогательные функции для логики отображения в таблице ---

    // Определяем, является ли возможность "высокоприбыльной"
    // Используем поле net_profit_pct (чистая прибыль), приходящее с бэкенда
    const isHighProfit = (opportunity) => {
        // TODO: Порог высокой прибыли можно сделать настраиваемым (например, через пропс из App.jsx или в настройках)
        // Пока используем статичный порог 0.5% чистой прибыли
        // Убедимся, что net_profit_pct существует и является числом
        return typeof opportunity?.net_profit_pct === 'number' && opportunity.net_profit_pct > 0.5;
    };

    // Определяем класс для ячейки прибыли (для цвета положительных/отрицательных значений)
    // Принимает числовое значение прибыли (%) или ($)
    const getValueClass = useCallback((value) => {
         if (value === undefined || value === null) return ''; // Игнорируем null/undefined
         const numValue = parseFloat(value);
         if (isNaN(numValue)) return ''; // Игнорируем нечисловые значения
         return numValue > 1e-9 ? 'positive-value' : (numValue < -1e-9 ? 'negative-value' : ''); // Используем допуск
    }, []); // Пустой массив зависимостей


    // Определяем количество скелетон-строк для отображения во время загрузки
    // Показываем скелетоны, если идет загрузка из App.jsx И нет отфильтрованных данных вообще (totalFilteredCount === 0)
    // ИЛИ если ошибка загрузки присутствует (чтобы показать индикацию в пустой таблице)
    // ИЛИ если opportunities пустой, но totalFilteredCount > 0 (идет загрузка конкретной страницы)
    const finalSkeletonRowCount = isLoadingApp && totalFilteredCount === 0 && !errorApp ? 10 : 0;


    // Определяем ключи и заголовки колонок
    // ОБНОВЛЕНЫ для новых полей
    const columnConfig = useMemo(() => [
        { key: 'buy_exchange', title: 'Биржа Покупка', sortable: true, filterable: true, className: 'col-buy-exchange' },
        { key: 'sell_exchange', title: 'Биржа Продажа', sortable: true, filterable: true, className: 'col-sell-exchange' },
        { key: 'symbol', title: 'Тикер', sortable: true, filterable: true, className: 'col-symbol' },
        { key: 'potential_profit_pct', title: 'Gross %', sortable: true, filterable: false, className: 'col-gross-profit-pct' }, // Фильтр для чисел не строкой
        { key: 'net_profit', title: 'Net %', sortable: true, filterable: false, className: 'col-net-profit' }, // Объединяем % и Quote в одну колонку для сортировки по %
        { key: 'executable_volume_base', title: 'Объем (Б.вал)', sortable: true, filterable: false, className: 'col-volume-base' }, // Фильтр для чисел не строкой
        { key: 'fees_paid_quote', title: 'Комиссии (Ц.вал)', sortable: true, filterable: false, className: 'col-fees-quote' }, // Фильтр для чисел не строкой
        { key: 'networks', title: 'Сети', sortable: false, filterable: true, className: 'col-networks' }, // Сети могут быть строковым фильтром
        { key: 'timestamp', title: 'Время Данных', sortable: false, filterable: false, className: 'col-timestamp' }, // Время данных обычно не сортируется по клику
        { key: 'time_since_update', title: 'С Обновления', sortable: true, filterable: false, className: 'col-time-since-update' }, // Время с обновления можно сортировать
        { key: 'actions', title: '', sortable: false, filterable: false, className: 'col-actions' }, // Действия (избранное, иконки)
    ], []); // Пустой массив зависимостей - вычисляется один раз


    return (
        <div className="table-wrapper">
             {/* Filter Controls UI - ПЕРЕНЕСЕНЫ В App.jsx */}
             {/* Filter Modal UI - ПЕРЕНЕСЕНЫ В App.jsx */}


            {/* Отображаем сообщение об ошибке загрузки из App.jsx */}
             {/* Показываем эту ошибку, только если нет никаких данных для отображения */}
             {errorApp && totalFilteredCount === 0 && (
                 <div className="error-message app-level-error"> {/* Добавляем класс для стилизации */}
                     <p>Ошибка приложения: {errorApp}</p>
                     {/* TODO: Возможно, добавить рекомендации пользователю */}
                 </div>
             )}


            <table role="grid">
                <thead>
                    <tr>
                        {columnConfig.map(col => (
                            <th
                                key={col.key}
                                // Определяем, можно ли сортировать по этой колонке
                                onClick={col.sortable ? () => requestSort(col.key) : undefined}
                                // Применяем класс сортировки, если сортировка активна для этого ключа
                                className={`${col.className} ${sortConfig?.key === col.key ? getSortDirectionClass(col.key) : ''}`}
                                // Атрибуты доступности для сортировки
                                aria-sort={sortConfig?.key === col.key ? (sortConfig.direction === 'ascending' ? 'ascending' : 'descending') : 'none'}
                                // Подсказка при наведении для сортируемых колонок
                                title={col.sortable ? `Сортировать по "${col.title}"` : undefined}
                            >
                                {col.title}
                            </th>
                        ))}
                    </tr>
                    {/* Строка поколоночных фильтров */}
                    {/* Отображаем строку фильтров только если активна страница arbitrage_cex */}
                     {activePage === 'arbitrage_cex' && ( // Отображаем фильтры только на странице арбитража
                         <tr>
                             {columnConfig.map(col => (
                                 <td key={`${col.key}-filter`} className={`filter-cell ${col.className}`}> {/* Добавляем класс колонки и к ячейке фильтра */}
                                     {/* Отображаем инпут фильтра только для колонок, по которым возможна фильтрация */}
                                     {col.filterable ? (
                                         <div className="filter-wrapper">
                                             <span className="filter-icon">🔍</span>
                                             <input
                                                 type="text"
                                                 placeholder="Фильтр..."
                                                 // Берем значение фильтра из App.jsx (props)
                                                 value={columnFilters[col.key] || ''}
                                                 // Вызываем колбэк из App.jsx при изменении
                                                 onChange={(e) => onColumnFilterChange(col.key, e.target.value)}
                                                 aria-label={`Фильтр по ${col.title}`}
                                             />
                                         </div>
                                     ) : (
                                          // Для колонок без фильтрации показываем заглушку
                                          <div className="filter-wrapper">
                                              {/* <span className="filter-icon">🔍</span> */} {/* Можно убрать иконку */}
                                              <input type="text" placeholder="..." disabled /> {/* Disabled input */}
                                          </div>
                                     )}
                                 </td>
                             ))}
                         </tr>
                     )}
                </thead>
                <tbody>
                     {/* --- Условный рендеринг содержимого tbody --- */}

                     {/* 1. Рендерим скелетоны, если идет загрузка И нет отфильтрованных данных */}
                       {/* Условие: идет загрузка (для первого сообщения) И общее количество отфильтрованных записей 0 И нет ошибки */}
                     {finalSkeletonRowCount > 0 ? (
                         Array.from({ length: finalSkeletonRowCount }).map((_, index) => (
                             <tr key={`skeleton-${index}`} className="skeleton-row">
                                 {columnConfig.map((col) => ( // Используем columnConfig для рендеринга ячеек скелетона
                                     <td key={col.key} className={col.className}> {/* Добавляем класс колонки к ячейке скелетона */}
                                         <div className="skeleton"></div>
                                     </td>
                                 ))}
                             </tr>
                         ))
                     ) : totalFilteredCount === 0 ? (
                          /* 2. Рендерим сообщение "Нет данных по фильтрам", если после фильтрации нет записей */
                          /* Это условие срабатывает, если totalFilteredCount равен 0 (и нет скелетонов). */
                         <tr>
                             <td colSpan={columnConfig.length} className="info-message">
                                 Арбитражные возможности не найдены по текущим фильтрам.
                             </td>
                         </tr>
                     ) : opportunities.length === 0 ? (
                         /* 3. Рендерим сообщение "На текущей странице нет записей", если отфильтрованных записей > 0, но ПАГИНИРОВАННЫЙ список пуст */
                          /* Это означает, что мы находимся на странице, где нет записей (например, последняя страница, которая оказалась пустой) */
                           <tr>
                                <td colSpan={columnConfig.length} className="info-message">
                                     На текущей странице нет записей ({currentPage} из {totalPages}). Попробуйте другую страницу или измените количество строк на странице.
                                 </td>
                           </tr>
                     ) : (
                         /* 4. Рендерим строки таблицы, если ни одно из вышеперечисленных условий не истинно И есть записи в пагинированном списке */
                         /* Это означает, что isLoadingApp не блокирует отображение, errorApp = null (или есть данные), totalFilteredCount > 0, И opportunities.length > 0. */
                         opportunities.map((opp) => {
                             // Используем стабильный ID с бэкенда для ключа строки
                             const opportunityId = opp.id;
                              // Проверяем, есть ли возможность в списке избранного по ее ID
                             const isFavorite = favorites.includes(opportunityId);
                             // Определяем, является ли возможность "исчезнувшей" (логика на фронтенде в App.jsx)
                            const isDisappeared = !opp.isActive && opp.disappearedAt;

                            return (
                                <tr
                                    key={opportunityId} // Уникальный ключ строки - ID с бэкенда
                                    onClick={() => onRowClick(opp)} // Вызываем колбэк из пропсов при клике на строку
                                    // Применяем классы для подсветки и "исчезнувших" строк
                                    className={`${isHighProfit(opp) ? 'high-profit' : ''} ${isDisappeared ? 'disappeared-row' : ''}`}
                                    role="row" // Для доступности
                                    aria-selected={false} // Если бы строки можно было выбирать
                                >
                                    {/* --- Рендеринг ячеек по ключу колонки --- */}
                                    {columnConfig.map(col => {
                                        // Специальная обработка для ключа 'net_profit', который объединяет % и Quote
                                        const cellValue = col.key === 'net_profit' ? { pct: opp.net_profit_pct, quote: opp.net_profit_quote } : opp[col.key]; // Значение для текущей ячейки

                                        // Специальный рендеринг для некоторых колонок
                                        if (col.key === 'buy_exchange' || col.key === 'sell_exchange') {
                                            const exchangeName = String(cellValue)?.toLowerCase(); // Имя биржи в нижнем регистре
                                            const logoSrc = exchangeLogos[exchangeName]; // Путь к логотипу
                                            return (
                                                 <td key={col.key} className={`${col.className} exchange-cell`}> {/* Добавляем класс колонки */}
                                                    <div className="exchange-cell"> {/* Используем flex для центрирования лого и текста */}
                                                        {/* Отображаем логотип, если есть */}
                                                        {logoSrc && (
                                                            <img
                                                                src={logoSrc}
                                                                alt={`${String(cellValue).toUpperCase() ?? 'N/A'} logo`} // Добавляем alt текст для доступности
                                                                className="exchange-logo"
                                                                // Скрываем изображение при ошибке загрузки
                                                                onError={(e) => { e.target.style.display = 'none'; console.warn(`Failed to load logo for ${String(cellValue)}`) }}
                                                            />
                                                        )}
                                                        {/* Отображаем название биржи в верхнем регистре */}
                                                        {String(cellValue)?.toUpperCase() ?? 'N/A'}
                                                    </div>
                                                 </td>
                                            );
                                        } else if (col.key === 'symbol') {
                                             return <td key={col.key} className={col.className}>{cellValue ?? 'N/A'}</td>; {/* Добавляем класс колонки */}
                                        } else if (col.key === 'potential_profit_pct') {
                                             // Отображаем Gross прибыль (%) с 4 знаками после запятой
                                             return (
                                                 <td
                                                     key={col.key}
                                                     className={`${col.className} profit-cell ${getValueClass(cellValue)}`} // Добавляем класс колонки, используем getValueClass для цвета
                                                     title={`Gross прибыль (без комиссий): ${typeof cellValue === 'number' ? cellValue.toFixed(4) : 'N/A'}%`}
                                                 >
                                                    {typeof cellValue === 'number' ? `${cellValue.toFixed(4)}%` : 'N/A'}
                                                 </td>
                                             );
                                         } else if (col.key === 'net_profit') {
                                             // Отображаем Net прибыль (%) и в Quote
                                             const netPct = cellValue.pct;
                                             const netQuote = cellValue.quote;
                                             const displayQuote = typeof netQuote === 'number' ? ` (${netQuote.toFixed(2)} Quote)` : '';

                                             return (
                                                 <td
                                                     key={col.key}
                                                     // Применяем класс для цвета на основе net_profit_pct
                                                     className={`${col.className} net-profit-cell ${getValueClass(netPct)}`} // Добавляем класс колонки
                                                      // Подсказка с Net прибылью в % и Quote, и исполняемым объемом
                                                      title={`Чистая прибыль (после комиссий): ${typeof netPct === 'number' ? netPct.toFixed(4) : 'N/A'}%${displayQuote}\nИсполняемый Объем: ${typeof opp.executable_volume_base === 'number' ? opp.executable_volume_base.toFixed(8) : 'N/A'} Base`}
                                                 >
                                                     {/* Отображаем Net % */}
                                                     {typeof netPct === 'number' ? `${netPct.toFixed(4)}%` : 'N/A'}
                                                     {/* Отображаем Net Quote в новой строке внутри ячейки */}
                                                      {typeof netQuote === 'number' && (
                                                          <div style={{fontSize: '0.9em', opacity: 0.9}}>
                                                              {netQuote.toFixed(2)} Quote
                                                          </div>
                                                      )}
                                                 </td>
                                             );
                                         } else if (col.key === 'executable_volume_base') {
                                             // Отображаем Исполняемый объем в базовой валюте
                                             return (
                                                  <td
                                                     key={col.key}
                                                     className={col.className} {/* Добавляем класс колонки */}
                                                     title={`Максимальный исполняемый объем: ${typeof cellValue === 'number' ? cellValue.toFixed(8) : 'N/A'} Base`}
                                                  >
                                                      {typeof cellValue === 'number' ? cellValue.toFixed(8) : 'N/A'}
                                                  </td>
                                             );
                                          } else if (col.key === 'fees_paid_quote') {
                                              // Отображаем общие комиссии в цитируемой валюте
                                               return (
                                                  <td
                                                      key={col.key}
                                                      className={`${col.className} ${getValueClass(cellValue > 1e-9 ? -cellValue : 0)}`} {/* Добавляем класс колонки, цвет для комиссий */}
                                                      title={`Общие комиссии (тейкерские): ${typeof cellValue === 'number' ? cellValue.toFixed(4) : 'N/A'} Quote`}
                                                  >
                                                      {typeof cellValue === 'number' ? cellValue.toFixed(4) : 'N/A'}
                                                  </td>
                                              );
                                           } else if (col.key === 'networks') {
                                               // Отображаем сети покупки/продажи (если доступны)
                                              const buyNetwork = opp.buy_network ?? 'N/A';
                                              const sellNetwork = opp.sell_network ?? 'N/A'; // Используем sell_network с бэкенда
                                                 return (
                                                     <td
                                                         key={col.key}
                                                         className={col.className} {/* Добавляем класс колонки */}
                                                         title={`Сети: ${buyNetwork} / ${sellNetwork}`}
                                                     >
                                                         {buyNetwork} / {sellNetwork}
                                                     </td>
                                                 );
                                               } else if (col.key === 'timestamp') {
                                                   // timestamp приходит с бэкенда в МИЛЛИсекундах
                                                   // Отображаем время данных в формате локального времени
                                                  return (
                                                      <td
                                                          key={col.key}
                                                          className={col.className} {/* Добавляем класс колонки */}
                                                          title={`Время данных на бэкенде (UTC): ${cellValue ? new Date(cellValue).toISOString() : 'N/A'}`}
                                                      >
                                                          {cellValue ? new Date(cellValue).toLocaleTimeString() : 'N/A'}
                                                      </td>
                                                  );
                                               } else if (col.key === 'time_since_update') {
                                                   // Время с обновления/исчезновения. formatTimeSince ожидает миллисекунды.
                                                   // opp.timestamp уже в ms. opp.disappearedAt (если есть) тоже в ms.
                                                   const timeToFormat = isDisappeared ? opp.disappearedAt : opp.timestamp;
                                                   const timeSinceText = formatTimeSince(timeToFormat);
                                                   const tooltipText = isDisappeared ? `Исчезла из фида ${timeSinceText} назад` : `Обновлено ${timeSinceText} назад`;
                                                   return (
                                                        <td key={col.key} className={col.className} title={tooltipText}> {/* Добавляем класс колонки */}
                                                          {timeSinceText}
                                                           {isDisappeared && <span title="Возможность исчезла из фида"> 👻</span>} {/* Иконка призрака для исчезнувших */}
                                                       </td>
                                                  );
                                              } else if (col.key === 'actions') {
                                                  return (
                                                      <td key={col.key} className={`${col.className}`}> {/* Добавляем класс колонки */}
                                                          {/* Кнопка "Добавить в избранное" */}
                                                          <button
                                                              className={`favorite-btn ${isFavorite ? 'favorited' : ''}`}
                                                              onClick={(e) => {
                                                                  e.stopPropagation(); // Останавливаем всплытие, чтобы не сработал клик по строке
                                                                  toggleFavorite(opp); // Вызываем колбэк для переключения избранного по ID
                                                              }}
                                                              aria-label={isFavorite ? 'Удалить из избранного' : 'Добавить в избранное'}
                                                              title={isFavorite ? 'Удалить из избранного' : 'Добавить в избранное'}
                                                          >
                                                              {isFavorite ? '★' : '☆'}
                                                          </button>
                                                      </td>
                                                  );
                                               }
                                               else {
                                                   // Резервный рендеринг для любых других полей
                                                   return <td key={col.key} className={col.className}>{String(cellValue) ?? 'N/A'}</td>; {/* Добавляем класс колонки */}
                                               }
                                      })}
                                   </tr>
                               );
                           })
                       )}
                       {/* Конец условного рендеринга tbody */}
                </tbody>
            </table>
        </div>
    );
}

export default OpportunityTable;