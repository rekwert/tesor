// frontend/src/components/Pagination.jsx
import React from 'react';
import './Pagination.css'; // <-- Импорт стилей

// Принимаем пропсы из App.jsx
function Pagination({ currentPage, totalPages, totalItems, itemsPerPage, onPageChange, onRowsPerPageChange }) {

    // Логика для генерации номеров страниц для отображения (опционально, для более сложных пагинаций)
    // Пока используем простые кнопки Назад/Вперед

    return (
        <div className="pagination-container" role="navigation" aria-label="Навигация по страницам"> {/* Добавляем класс для контейнера и роли доступности */}
            <span className="pagination-info"> {/* Класс для текстовой информации */}
                Страница {currentPage} из {totalPages} | Всего записей: {totalItems}
            </span>

            <div className="pagination-controls"> {/* Класс для группировки кнопок */}
                <button
                     onClick={() => onPageChange(currentPage - 1)}
                     disabled={currentPage === 1}
                     aria-label="Предыдущая страница"
                >
                    Назад
                </button>
                {/* Можно добавить кнопки с номерами страниц здесь */}
                 {/* Например: <span className="current-page">{currentPage}</span> */}
                 <button
                     onClick={() => onPageChange(currentPage + 1)}
                     disabled={currentPage === totalPages || totalPages <= 1} // Деактивируем, если последняя страница или всего 1
                     aria-label="Следующая страница"
                 >
                     Вперед
                 </button>
            </div>

            <div className="rows-per-page-control"> {/* Класс для элемента выбора количества строк */}
                 <label className="rows-per-page-label"> {/* Используем класс из App.css */}
                     Строк на странице:
                      <select value={itemsPerPage} onChange={onRowsPerPageChange} aria-label="Выберите количество строк на странице">
                         <option value={10}>10</option>
                         <option value={25}>25</option>
                         <option value={50}>50</option>
                         <option value={100}>100</option>
                      </select>
                 </label>
            </div>
        </div>
    );
}

export default Pagination;