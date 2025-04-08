import React, {useState, useRef} from 'react';
import {formatTime} from '../../utils/date'; // Переконайтесь, що шлях правильний

interface ProgressProps {
    duration: number;
    currentTime: number;
    onSeek: (time: number) => void;
}

const Progress: React.FC<ProgressProps> = ({duration, currentTime, onSeek}) => {
    const progressBarRef = useRef<HTMLDivElement>(null);
    const [isHovering, setIsHovering] = useState(false);
    const [hoverTime, setHoverTime] = useState(0);
    const [hoverPositionX, setHoverPositionX] = useState(0);

    const calculateTime = (event: React.MouseEvent<HTMLDivElement>): number => {
        if (!progressBarRef.current || !duration) return 0;
        const rect = progressBarRef.current.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const widthFraction = Math.max(0, Math.min(1, clickX / rect.width));
        return widthFraction * duration;
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!duration) return;
        const time = calculateTime(event);
        const posX = event.clientX - (progressBarRef.current?.getBoundingClientRect().left ?? 0);
        setHoverTime(time);
        setHoverPositionX(posX);
        if (!isHovering) setIsHovering(true);
    };

    const handleMouseLeave = () => {
        setIsHovering(false);
    };

    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!duration) return;
        const time = calculateTime(event);
        onSeek(time);
    };

    // Розрахунок відсотка прогресу
    const progressPercent = (duration > 0 && Number.isFinite(duration) && Number.isFinite(currentTime))
        ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) // Додано перевірку currentTime та Math.max
        : 0;

    // console.log(`Progress Rendering: currentTime=${currentTime.toFixed(2)}, percent=${progressPercent.toFixed(2)}%`); // Додатковий лог

    return (
        <div
            ref={progressBarRef}
            className='relative w-full bg-gray-600 rounded-full h-2 cursor-pointer group'
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
        >
            {/* Смуга прогресу (без transition) */}
            <div
                className="absolute left-0 top-0 rounded-full bg-primary h-2"
                style={{width: `${progressPercent}%`}}
            ></div>

            {/* Маркер поточного часу (без transition) */}
            <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-secondary rounded-full shadow -ml-2 pointer-events-none"
                style={{left: `${progressPercent}%`}}
            ></div>

            {/* Tooltip */}
            {isHovering && duration > 0 && (
                <div
                    className="absolute bottom-full mb-2 px-2 py-1 bg-black bg-opacity-70 text-white text-xs rounded pointer-events-none whitespace-nowrap"
                    style={{
                        left: `${hoverPositionX}px`,
                        transform: 'translateX(-50%)',
                    }}
                >
                    {formatTime(hoverTime)}
                </div>
            )}
        </div>
    );
};

export default Progress;
