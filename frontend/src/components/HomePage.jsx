import React from 'react';
import './HomePage.css';

// Теперь принимаем onSelectView как пропс и используем его
function HomePage({ onSelectView }) {
    return (
        <div className="homepage">
            <div className="hero-section">
                <h1>Оптимизируйте арбитраж с нами</h1>
                <p>Мгновенные данные по CEX и DEX для максимальной прибыли.</p>
            </div>
            <h2>Выберите тип арбитража:</h2>
            <div className="homepage-options">
                <button
                    onClick={() => onSelectView('arbitrage_cex')} // Используем onSelectView
                    className="option-button cex-button"
                    aria-label="CEX Арбитраж"
                >
                    CEX Арбитраж
                </button>
                <button
                    onClick={() => onSelectView('arbitrage_dex')} // Используем onSelectView
                    disabled
                    className="option-button dex-button"
                    aria-label="DEX Арбитраж (Скоро)"
                >
                    DEX Арбитраж
                </button>
            </div>
<div className="homepage-features">
                <div className="feature-card">
                    <h3>Мгновенные данные</h3>
                    <p>Обновления цен и возможностей в реальном времени.</p>
                </div>
                <div className="feature-card">
                    <h3>Гибкие фильтры</h3>
                    <p>Настройте отображение под свои стратегии.</p>
                </div> {/* <-- ВОТ ЭТОТ ТЕГ НУЖНО ДОБАВИТЬ */}
                <div className="feature-card">
                    <h3>Аналитика прибыли</h3>
                    <p>Калькуляторы и метрики для точных решений.</p>
                </div>
            </div>
        </div>
    );
}

export default HomePage;