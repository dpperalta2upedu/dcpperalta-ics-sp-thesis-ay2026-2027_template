import React from "react";

type WrapTextProps = {
  text: string;
  x: number;
  y: number;
  maxCharsPerLine?: number;
  lineHeight?: number;
};

const WrapText: React.FC<WrapTextProps> = ({
  text,
  x,
  y,
  maxCharsPerLine = 8,
  lineHeight = 9,
}) => {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];

  let current = "";

  words.forEach(word => {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxCharsPerLine) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = test;
    }
  });

  if (current) lines.push(current);

  // 🔑 center vertically
  const startY = y - ((lines.length - 1) * lineHeight) / 2;

  return (
    <>
      {lines.map((line, i) => (
        <tspan
          key={i}
          x={x}
          y={startY + i * lineHeight}
        >
          {line}
        </tspan>
      ))}
    </>
  );
};

export default WrapText;
