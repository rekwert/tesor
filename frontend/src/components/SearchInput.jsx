// frontend/src/components/SearchInput.jsx
import React from 'react';
// import './SearchInput.css'; // <-- Опционально: импорт стилей

// Принимаем пропсы: value (текущее значение), onChange (обработчик изменения), placeholder (текст-подсказка)
function SearchInput({ value, onChange, placeholder = "Поиск..." }) {
    // Поле поиска использует общие стили input[type="text"] из App.css controls
    // Дополнительные стили можно добавить в SearchInput.css и применить к инпуту

    return (
        <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
             // className="search-input" // Опционально: добавить класс для специфичных стилей
            aria-label={placeholder} // Для доступности
        />
    );
}

export default SearchInput;