// frontend/src/utils/timeUtils.js

// Функция для форматирования времени с момента timestamp (в миллисекундах)
// Используется для отображения "времени с обновления" или "времени с исчезновения"
export const formatTimeSince = (timestamp) => {
    // timestamp должен быть в миллисекундах для Date.now()
    // Проверяем, что timestamp существует, является числом и положительным
    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
        return 'N/A'; // Возвращаем "Нет данных", если timestamp некорректный
    }

    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) {
        // Если timestamp в будущем (такого быть не должно для времени данных/обновления), показываем 0 сек
        return '0 сек';
    }

    // Переводим разницу в секунды
    const diffSeconds = Math.floor(diffMs / 1000);

    if (diffSeconds < 60) {
        // Меньше минуты
        return `${diffSeconds} сек`;
    } else if (diffSeconds < 3600) {
        // Меньше часа
        const minutes = Math.floor(diffSeconds / 60);
        const seconds = diffSeconds % 60;
        // Отображаем секунды, только если их > 0, чтобы не было "5 мин 0 сек"
        return seconds > 0 ? `${minutes} мин ${seconds} сек` : `${minutes} мин`;
    } else if (diffSeconds < 86400) {
        // Меньше 24 часов
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        // Отображаем минуты, только если их > 0
        return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
    } else {
        // Более 24 часов
        const days = Math.floor(diffSeconds / 86400);
        const hours = Math.floor((diffSeconds % 86400) / 3600);
         // Отображаем часы, только если их > 0
        return hours > 0 ? `${days} д ${hours} ч` : `${days} д`;
    }
};

// Функция getOpportunityId удалена, так как стабильный ID теперь предоставляется бэкендом.