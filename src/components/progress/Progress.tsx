import React, {useState, useRef} from 'react';
import {formatTime} from '../../utils/date'; // Переконайтесь, що шлях правильний

interface ProgressProps {
    duration: number;
    currentTime: number;
    onSeek: (time: number) => void; // Callback для перемотування
}

const Progress: React.FC<ProgressProps> = ({duration, currentTime, onSeek}) => {
    const progressBarRef = useRef<HTMLDivElement>(null);
    const [isHovering, setIsHovering] = useState(false);
    const [hoverTime, setHoverTime] = useState(0);
    const [hoverPositionX, setHoverPositionX] = useState(0);

    const calculateTime = (event: React.MouseEvent<HTMLDivElement>): number => {
        if (!progressBarRef.current || !duration) return 0;

        const rect = progressBarRef.current.getBoundingClientRect();
        // Отримуємо X координату кліку/курсору відносно елемента
        const clickX = event.clientX - rect.left;
        // Обчислюємо частку від загальної ширини
        const widthFraction = Math.max(0, Math.min(1, clickX / rect.width));
        // Обчислюємо час, що відповідає цій позиції
        return widthFraction * duration;
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!duration) return;
        const time = calculateTime(event);
        const posX = event.clientX - (progressBarRef.current?.getBoundingClientRect().left ?? 0);

        setHoverTime(time);
        setHoverPositionX(posX);
        if (!isHovering) {
            setIsHovering(true);
        }
    };

    const handleMouseLeave = () => {
        setIsHovering(false);
    };

    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!duration) return;
        const time = calculateTime(event);
        onSeek(time); // Викликаємо callback для перемотування
    };

    // Запобігаємо діленню на нуль або отриманню NaN/Infinity
    const progressPercent = (duration > 0 && Number.isFinite(duration))
        ? Math.min(100, (currentTime / duration) * 100)
        : 0;

    return (
        <div
            ref={progressBarRef}
            className='relative w-full bg-gray-600 rounded-full h-2 cursor-pointer group' // Додано group для керування tooltip
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
        >
            {/* Смуга прогресу */}
            <div
                className="absolute left-0 top-0 rounded-full bg-primary h-2 transition-all duration-75 ease-linear" // Плавний перехід для currentTime
                style={{width: `${progressPercent}%`}}
            ></div>

            {/* Маркер поточного часу (опціонально, робить його помітнішим) */}
            <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-secondary rounded-full shadow -ml-2 pointer-events-none transition-all duration-75 ease-linear" // Забороняємо події миші для маркера
                style={{left: `${progressPercent}%`}}
            ></div>

            {/* Tooltip (спливаюче вікно) */}
            {isHovering && duration > 0 && (
                <div
                    className="absolute bottom-full mb-2 px-2 py-1 bg-black bg-opacity-70 text-white text-xs rounded pointer-events-none whitespace-nowrap" // Забороняємо події миші
                    style={{
                        left: `${hoverPositionX}px`,
                        transform: 'translateX(-50%)', // Центруємо над курсором
                    }}
                >
                    {formatTime(hoverTime)}
                </div>
            )}
        </div>
    );
};

export default Progress;
