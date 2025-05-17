// frontend/src/components/SettingsModal.jsx
import React from 'react';
import './SettingsModal.css'; // <-- Импорт стилей

// Принимаем пропсы из App.jsx
function SettingsModal({
    show,
    onClose,
    userBuyCommissionPct, setUserBuyCommissionPct,
    userSellCommissionPct, setUserSellCommissionPct,
    userInvestmentAmount, setUserInvestmentAmount,
    theme
}) {
     // Если show равно false, компонент не рендерится
    if (!show) {
        return null;
    }

    // TODO: Добавьте реальную разметку и логику для модального окна настроек.
    // Здесь должны быть поля ввода для userBuyCommissionPct, userSellCommissionPct, userInvestmentAmount.

    return (
         <div className="modal-overlay" onClick={onClose}>
             <div className={`settings-modal modal-content ${theme}-theme`} onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="settings-modal-title"> {/* Добавляем settings-modal класс и modal-content */}
                <h3 id="settings-modal-title">Настройки пользователя</h3>

                <div className="settings-section"> {/* Группа настроек комиссий */}
                    <h4>Комиссии (%)</h4>
                    <div className="input-group"> {/* Используем существующий класс input-group */}
                         <label>
                             Покупка:
                             <input
                                 type="number"
                                 value={userBuyCommissionPct}
                                 onChange={(e) => setUserBuyCommissionPct(Number(e.target.value))}
                                 min="0"
                                 step="any" // Позволяем дробные
                                 aria-label="Комиссия на покупку в процентах"
                                 style={{ width: '60px' }} // Небольшая фиксированная ширина
                             />
                         </label>
                          <label>
                             Продажа:
                             <input
                                 type="number"
                                 value={userSellCommissionPct}
                                 onChange={(e) => setUserSellCommissionPct(Number(e.target.value))}
                                 min="0"
                                 step="any" // Позволяем дробные
                                 aria-label="Комиссия на продажу в процентах"
                                  style={{ width: '60px' }} // Небольшая фиксированная ширина
                             />
                         </label>
                    </div>
                </div>

                <div className="settings-section"> {/* Группа настройки инвестиции */}
                    <h4>Сумма инвестиции по умолчанию ($)</h4>
                     <div className="input-group"> {/* Используем существующий класс input-group */}
                         <label>
                             Сумма:
                             <input
                                 type="number"
                                 value={userInvestmentAmount}
                                 onChange={(e) => setUserInvestmentAmount(Number(e.target.value))}
                                 min="1"
                                 step="any" // Позволяем дробные
                                  aria-label="Сумма инвестиции по умолчанию в долларах"
                                   style={{ width: '80px' }} // Небольшая фиксированная ширина
                             />
                         </label>
                     </div>
                </div>

                {/* Кнопка закрытия */}
                 <div className="filter-modal-actions"> {/* Используем класс действий из модалки фильтров */}
                    <button onClick={onClose} className="modal-close-btn"> {/* Используем класс кнопки из модалки фильтров */}
                        Закрыть
                    </button>
                 </div>
            </div>
        </div>
    );
}

export default SettingsModal;