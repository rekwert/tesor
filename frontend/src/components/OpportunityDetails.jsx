// frontend/src/components/OpportunityDetails.jsx
import React, { useState, useEffect, useCallback } from 'react';
import './OpportunityDetails.css'; // <-- Импорт стилей
// Убедитесь, что formatTimeSince импортирован, если используется напрямую здесь (сейчас не используется)
// import { formatTimeSince } from '../utils/timeUtils.js';


// Принимаем opportunity (с новыми полями), onClose, пользовательские настройки и тему
function OpportunityDetails({ opportunity, onClose, userBuyCommissionPct, userSellCommissionPct, userInvestmentAmount, theme }) {
    // Если opportunity равен null (например, модалка закрыта), не рендерим ничего
    if (!opportunity) {
        return null;
    }

    // Инициализируем локальные состояния калькулятора из переданных пропсов (пользовательских настроек)
    // Используем значения из user...Amount/Pct, т.к. они уже берутся из localStorage в App.jsx
    const [investmentAmountInput, setInvestmentAmountInput] = useState(userInvestmentAmount ?? 100);
    const [buyCommissionPctInput, setBuyCommissionPctInput] = useState(userBuyCommissionPct ?? 0.1);
    const [sellCommissionPctInput, setSellCommissionPctInput] = useState(userSellCommissionPct ?? 0.1);

    // Локальные состояния для отображения результатов ЛОКАЛЬНОГО калькулятора
    // Теперь это ОЦЕНОЧНАЯ прибыль на основе пользовательского ввода, масштабированная от Net прибыли бэкенда
    const [estimatedNetProfitUSD, setEstimatedNetProfitUSD] = useState(null);
     // Сохраним Gross Profit (%) из бэкенда для отображения в калькуляторе тоже
    const [opportunityGrossProfitPct, setOpportunityGrossProfitPct] = useState(opportunity.potential_profit_pct);


    // Эффект для сброса локального калькулятора при смене выбранной возможности ИЛИ ИЗМЕНЕНИИ НАСТРОЕК ПОЛЬЗОВАТЕЛЯ
    useEffect(() => {
        // При изменении opportunity (открытии деталей для другой возможности) или глобальных настроек пользователя,
        // сбрасываем локальные значения калькулятора на текущие глобальные настройки
        console.log("OpportunityDetails: Resetting calculator inputs to user settings.");
        setInvestmentAmountInput(userInvestmentAmount ?? 100);
        setBuyCommissionPctInput(userBuyCommissionPct ?? 0.1); // Эти комиссии пока не используются в расчете прибыли, но могут быть использованы позже.
        setSellCommissionPctInput(userSellCommissionPct ?? 0.1); // Храним их на случай, если захотим использовать в будущем

        // Сбрасываем рассчитанные значения, чтобы пользователь нажал "Рассчитать" с новыми дефолтами
        setEstimatedNetProfitUSD(null);
        setOpportunityGrossProfitPct(opportunity.potential_profit_pct); // Сбрасываем Gross % к тому, что пришел с бэкенда


        // Автоматически рассчитываем прибыль при открытии модалки с новой возможностью,
        // используя пользовательские настройки по умолчанию (которые уже загружены).
        // Вызываем calculateProfit с текущими значениями из локального состояния.
         // Но убедимся, что opportunity имеет нужные данные перед расчетом
         if (opportunity && typeof opportunity.executable_volume_base === 'number' &&
             typeof opportunity.buy_price === 'number' && typeof opportunity.net_profit_quote === 'number' &&
             userInvestmentAmount > 0 && opportunity.executable_volume_base > 1e-9 && opportunity.buy_price > 1e-9) {
               // Используем userInvestmentAmount из пропсов для первого авто-расчета
               // console.log("OpportunityDetails: Auto-calculating profit on mount/opportunity change.");
               calculateProfit(userInvestmentAmount, opportunity.executable_volume_base, opportunity.buy_price, opportunity.net_profit_quote);
          } else {
               // console.log("OpportunityDetails: Cannot auto-calculate profit, missing data.", opportunity);
               setEstimatedNetProfitUSD('N/A');
          }


     }, [opportunity, userInvestmentAmount, userBuyCommissionPct, userSellCommissionPct]); // Зависит от выбранной возможности и пользовательских настроек


    // Функция расчета прибыли на основе введенной суммы (ЛОКАЛЬНЫЙ КАЛЬКУЛЯТОР)
    // Теперь просто масштабируем чистую прибыль с бэкенда
    const calculateProfit = useCallback((investmentAmount, executableVolumeBase, buyPrice, netProfitQuote) => {
        // Используем значения, переданные в функцию, или из локального состояния (для кнопки)
        const currentInvestment = investmentAmount ?? parseFloat(investmentAmountInput);
        // const currentBuyCommission = parseFloat(buyCommissionPctInput); // Пока не используются
        // const currentSellCommission = parseFloat(sellCommissionPctInput); // Пока не используются

        // Берем данные о возможности с бэкенда
        const oppExecutableVolumeBase = executableVolumeBase ?? opportunity.executable_volume_base;
        const oppBuyPrice = buyPrice ?? opportunity.buy_price;
        const oppNetProfitQuote = netProfitQuote ?? opportunity.net_profit_quote;


        // Валидация входных данных и данных возможности
        if (isNaN(currentInvestment) || currentInvestment <= 0 ||
             typeof oppExecutableVolumeBase !== 'number' || oppExecutableVolumeBase <= 1e-9 ||
             typeof oppBuyPrice !== 'number' || oppBuyPrice <= 1e-9 ||
             typeof oppNetProfitQuote !== 'number')
             {
            console.warn("Calculator: Invalid input or opportunity data for calculation.");
            setEstimatedNetProfitUSD('N/A');
            return;
        }

        // Рассчитываем стоимость "стандартной" сделки с бэкенда в Quote валюте
        // Это приблизительно executable_volume_base * buy_price
        const oppCostQuote = oppExecutableVolumeBase * oppBuyPrice;

        // Проверяем, что oppCostQuote не равен нулю во избежание деления на ноль
        if (oppCostQuote <= 1e-9) {
             console.warn("Calculator: Opportunity cost in Quote is zero or negligible.");
             setEstimatedNetProfitUSD('N/A');
             return;
        }

        // Масштабируем Net прибыль бэкенда пропорционально пользовательской инвестиции
        // Предполагаем, что userInvestmentAmount в Quote валюте
        const scaleFactor = currentInvestment / oppCostQuote;

        // Оценочная чистая прибыль в Quote валюте для пользовательской инвестиции
        const estimatedProfit = oppNetProfitQuote * scaleFactor;


        // Обновляем локальные состояния с результатами
        // CalculatedGrossProfitUSD не рассчитываем локально этим методом, т.к. это сложно без полной симуляции стакана.
        // setCalculatedGrossProfitUSD(null); // Оставляем null, или можно масштабировать Gross Quote тоже?
        setEstimatedNetProfitUSD(estimatedProfit); // Сохраняем как число для отображения


        // TODO: Добавить учет комиссии за перевод между биржами в локальном калькуляторе
        // Для этого нужны данные о сети и комиссии вывода с buy_exchange в sell_exchange
        // Это сложно и требует данных с бэкенда.
    }, [opportunity, investmentAmountInput, buyCommissionPctInput, sellCommissionPctInput]); // Зависит от opportunity и локальных инпутов


    // Вспомогательная функция для определения класса цвета для значений прибыли
    // Используем useCallback для мемоизации, если она вызывается много раз (здесь не критично)
    const getValueClass = useCallback((value) => {
        if (value === undefined || value === null) return ''; // Игнорируем null/undefined
        const numValue = parseFloat(value);
        if (isNaN(numValue)) return ''; // Игнорируем нечисловые
        // Используем допуск для сравнения float с нулем
        return numValue > 1e-9 ? 'positive-value' : (numValue < -1e-9 ? 'negative-value' : '');
    }, []); // Пустой массив зависимостей


    return (
        // Используем overlay для затемнения фона и центрирования модалки
        <div className="modal-overlay" onClick={onClose}> {/* Нажатие на фон закрывает модалку */}
            {/* Предотвращаем закрытие при клике внутри модалки */}
            {/* Добавляем класс opportunity-details и modal-content из App.css */}
            <div className={`opportunity-details modal-content ${theme}-theme`} onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="details-title">
                <h3 id="details-title">
                    Детали для {opportunity.symbol ?? 'N/A'}:
                    {opportunity.buy_exchange ? opportunity.buy_exchange.toUpperCase() : 'N/A'} →
                    {opportunity.sell_exchange ? opportunity.sell_exchange.toUpperCase() : 'N/A'}
                </h3>

                <div className="details-content">
                     {/* Отображаем РЕАЛЬНУЮ Net прибыль и объем с бэкенда (для executable_volume_base) */}
                     <p>
                         <strong>Чистая прибыль ({typeof opportunity.net_profit_pct === 'number' ? opportunity.net_profit_pct.toFixed(4) : 'N/A'}%):</strong> {/* Показываем % в заголовке */}
                         {/* Применяем класс цвета на основе net_profit_quote с бэкенда */}
                         <span className={getValueClass(opportunity.net_profit_quote)}>
                              {typeof opportunity.net_profit_quote === 'number' ? `${opportunity.net_profit_quote.toFixed(2)} Quote` : 'N/A'}
                         </span>
                         {/* Добавляем подсказку, что это без учета вывода */}
                         <small style={{ display: 'block', fontSize: '0.8em', opacity: 0.8, marginTop: '3px' }}>(Для объема {typeof opportunity.executable_volume_base === 'number' ? opportunity.executable_volume_base.toFixed(8) : 'N/A'} Base. Без учета комиссий за вывод/перевод)</small>
                    </p>
                     <p>
                         <strong>Исполняемый Объем (Base):</strong> {/* Объем, рассчитанный бэкендом */}
                         {typeof opportunity.executable_volume_base === 'number' ? opportunity.executable_volume_base.toFixed(8) : 'N/A'}
                     </p>

                    {/* Остальные детали возможности, пришедшие с бэкенда */}
                    <p>
                        <strong>Символ:</strong> {opportunity.symbol ?? 'N/A'}
                    </p>
                    <p>
                        <strong>Биржа покупки:</strong>
                        {opportunity.buy_exchange ? opportunity.buy_exchange.toUpperCase() : 'N/A'} @
                        {typeof opportunity.buy_price === 'number' ? opportunity.buy_price.toFixed(8) : 'N/A'}
                    </p>
                    <p>
                        <strong>Биржа продажи:</strong>
                        {opportunity.sell_exchange ? opportunity.sell_exchange.toUpperCase() : 'N/A'} @
                        {typeof opportunity.sell_price === 'number' ? opportunity.sell_price.toFixed(8) : 'N/A'}
                    </p>
                    <p>
                        <strong>Gross прибыль (без комиссий):</strong> {/* Это Gross прибыль, рассчитанная бэкендом для executable_volume_base */}
                        {typeof opportunity.potential_profit_pct === 'number' ? opportunity.potential_profit_pct.toFixed(4) : 'N/A'}%
                    </p>
                    <p>
                         <strong>Общие комиссии (тейкер):</strong> {/* Общие комиссии, рассчитанные бэкендом */}
                         {/* Применяем класс цвета, если комиссии есть и они > 0 */}
                         <span className={getValueClass(opportunity.fees_paid_quote > 1e-9 ? -opportunity.fees_paid_quote : 0)}>
                             {typeof opportunity.fees_paid_quote === 'number' ? opportunity.fees_paid_quote.toFixed(4) : 'N/A'} Quote
                         </span>
                    </p>

                    {/* Отображаем информацию о сетях, если доступна */}
                    <p>
                        <strong>Сеть покупки:</strong>
                         <span title={`Сеть покупки: ${opportunity.buy_network ?? 'Не указана'}`}>
                            {opportunity.buy_network ?? 'N/A'}
                         </span>
                    </p>
                    <p>
                        <strong>Сеть продажи:</strong>
                        <span title={`Сеть продажи: ${opportunity.sell_network ?? 'Не указана'}`}>
                            {opportunity.sell_network ?? 'N/A'}
                        </span>
                    </p>

                    {/* Время данных и время появления/исчезновения */}
                    <p>
                        <strong>Время данных (UTC):</strong> {/* Уточняем текст */}
                        {opportunity.timestamp ? new Date(opportunity.timestamp).toLocaleString() : 'N/A'} {/* timestamp приходит в ms */}
                    </p>
                     {/* Время первого появления на фронтенде (internal state) */}
                     {opportunity.appearedAt && (
                         <p>
                              <strong>Время первого появления в фиде:</strong>
                              {new Date(opportunity.appearedAt).toLocaleString()}
                         </p>
                     )}
                     {/* Время исчезновения с фида (internal state) */}
                     {!opportunity.isActive && opportunity.disappearedAt && (
                          <p>
                              <strong>Время исчезновения из фида:</strong>
                              {new Date(opportunity.disappearedAt).toLocaleString()}
                          </p>
                      )}


                    {/* Индикатор разницы цен между биржами (только Gross спред) */}
                    <div className="price-difference">
                        {/* Расчет разницы цен между биржами в % на основе buy_price и sell_price (исполненных цен) */}
                         const priceDifferencePct = typeof opportunity.buy_price === 'number' && typeof opportunity.sell_price === 'number' && opportunity.buy_price > 1e-9
                             ? ((opportunity.sell_price - opportunity.buy_price) / opportunity.buy_price * 100)
                             : null;
                        <strong>Разница исполненных цен (%):</strong> {/* Уточняем текст */}
                        <span className={getValueClass(priceDifferencePct)}> {/* Применяем класс цвета */}
                            {typeof priceDifferencePct === 'number' ? `${priceDifferencePct.toFixed(2)}%` : 'N/A'}
                        </span>
                         <p style={{fontSize: '0.9em', color: 'inherit', marginTop: '5px', opacity: 0.8}}>
                             <small>(Расчет: (ЦенаПродажи - ЦенаПокупки) / ЦенаПокупки * 100)</small>
                         </p>
                    </div>


                    {/* ЛОКАЛЬНЫЙ Калькулятор прибыли (для "что если" сценариев) */}
                    <div className="profit-calculator">
                         {/* Заголовок калькулятора */}
                        <h4>Оценочная прибыль (с учетом вложенной суммы)</h4>
                        <p style={{fontSize: '0.9em', opacity: 0.8, marginBottom: '15px'}}>
                            Рассчитайте примерную прибыль, используя желаемую сумму инвестиции. Расчет основан на чистой прибыли возможности, определенной сканером.
                            {/* TODO: Уточнить, что расчет НЕ учитывает комиссии вывода и пользовательские тейкерские комиссии пока */}
                        </p>

                        {/* Поля ввода для калькулятора */}
                        <div className="input-group">
                             <label>
                                 Инвестиция (Quote): {/* Уточняем, что это в Quote валюте */}
                                 <input
                                     type="number"
                                     value={investmentAmountInput} // Используем локальное состояние для ввода
                                     onChange={(e) => {
                                         // Обновляем локальное состояние ввода
                                         setInvestmentAmountInput(e.target.value);
                                         // Сбрасываем рассчитанные значения, чтобы требовался клик по "Рассчитать"
                                         setEstimatedNetProfitUSD(null);
                                     }}
                                     min="0"
                                     step="any" // Позволяем дробные значения
                                     aria-label="Сумма инвестиции в Quote для калькулятора"
                                 />
                             </label>
                             {/* Пока скрываем поля комиссий, т.к. они не используются в текущем расчете масштабирования */}
                             {/*
                             <label>
                                 Комиссия покупки (%):
                                 <input
                                     type="number"
                                     value={buyCommissionPctInput}
                                     onChange={(e) => setBuyCommissionPctInput(Number(e.target.value))}
                                     min="0"
                                     step="any"
                                      aria-label="Комиссия на бирже покупки в процентах для калькулятора"
                                 />
                             </label>
                              <label>
                                 Комиссия продажи (%):
                                 <input
                                     type="number"
                                     value={sellCommissionPctInput}
                                     onChange={(e) => setSellCommissionPctInput(Number(e.target.value))}
                                     min="0"
                                     step="any"
                                      aria-label="Комиссия на бирже продажи в процентах для калькулятора"
                                 />
                             </label>
                              */}
                        </div>
                        <button onClick={() => calculateProfit()} aria-label="Рассчитать прибыль с пользовательскими настройками">
                            Рассчитать
                        </button>
                        {/* TODO: Добавить кнопку "Сбросить к настройкам по умолчанию" для инпутов калькулятора */}

                        {/* Результаты расчета */}
                        {estimatedNetProfitUSD !== null && (
                            <div className="result-row">
                                 {estimatedNetProfitUSD === 'N/A' ? (
                                     <p>Некорректные входные данные или данные возможности для расчета.</p>
                                 ) : (
                                     <>
                                         {/* Оценочная Net прибыль в Quote валюте */}
                                         <p className={getValueClass(estimatedNetProfitUSD)}> {/* Применяем класс цвета */}
                                            <strong>Оценочная Net Прибыль:</strong> {typeof estimatedNetProfitUSD === 'number' ? estimatedNetProfitUSD.toFixed(2) : 'N/A'} Quote
                                        </p>
                                        {/* TODO: Опционально: Отобразить оценочную Gross прибыль и комиссии, если они будут рассчитываться */}
                                     </>
                                 )}
                            </div>
                        )}
                         {/* TODO: Добавить поле для комиссии за вывод/перевод в локальный калькулятор */}
                    </div>
                </div>

                {/* Кнопка закрытия модального окна */}
                {/* Используем существующий класс кнопки закрытия модалки */}
                <button
                    className="modal-close-btn"
                    onClick={onClose}
                    aria-label="Скрыть детали арбитражной возможности"
                >
                    Закрыть
                </button>
            </div>
        </div>
    );
}

export default OpportunityDetails;