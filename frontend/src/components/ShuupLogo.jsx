import React from "react";

export default function ShuupLogo({ size = 180, showText = true }) {
  const scale = size / 200;

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
      <svg
        width={200 * scale}
        height={160 * scale}
        viewBox="0 0 200 160"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ filter: "drop-shadow(0 8px 20px rgba(0,0,0,0.25))" }}
      >
        {/* Antenna */}
        <line x1="82" y1="36" x2="60" y2="10" stroke="#f25c3b" strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="58" cy="8" r="4.5" fill="#f25c3b" />
        <line x1="118" y1="36" x2="140" y2="10" stroke="#f25c3b" strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="142" cy="8" r="4.5" fill="#f25c3b" />

        {/* TV Legs */}
        <polygon points="50,140 62,140 56,152 44,152" fill="#d94828" />
        <polygon points="150,140 138,140 144,152 156,152" fill="#d94828" />

        {/* TV Main Body */}
        <rect x="20" y="32" width="160" height="110" rx="24" fill="#f25c3b" />

        {/* Subtle 3D bottom shading on TV body */}
        <rect x="20" y="134" width="160" height="8" rx="4" fill="#d94828" opacity="0.6" />

        {/* White Screen */}
        <rect x="32" y="44" width="108" height="86" rx="16" fill="#ffffff" />

        {/* Screen Content: "Shuup" */}
        {showText && (
          <g>
            <text
              x="86"
              y="93"
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
              fontWeight="900"
              fontSize="28"
              fill="#f25c3b"
              letterSpacing="-0.5px"
            >
              Shuup
            </text>
            <text
              x="86"
              y="114"
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
              fontWeight="800"
              fontSize="12"
              fill="#10b981"
              letterSpacing="1.5px"
            >
              LIVE
            </text>
          </g>
        )}

        {/* Right TV Controls: Two Knobs & Speaker Holes */}
        <circle cx="156" cy="62" r="6" fill="#ffffff" />
        <circle cx="156" cy="80" r="6" fill="#ffffff" />
        
        {/* Speaker dots */}
        <circle cx="152" cy="100" r="2.5" fill="#ffffff" opacity="0.75" />
        <circle cx="160" cy="100" r="2.5" fill="#ffffff" opacity="0.75" />
        <circle cx="152" cy="108" r="2.5" fill="#ffffff" opacity="0.75" />
        <circle cx="160" cy="108" r="2.5" fill="#ffffff" opacity="0.75" />
        <circle cx="152" cy="116" r="2.5" fill="#ffffff" opacity="0.75" />
        <circle cx="160" cy="116" r="2.5" fill="#ffffff" opacity="0.75" />
      </svg>
    </div>
  );
}

