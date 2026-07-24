import type { ButtonHTMLAttributes, ReactNode } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  size?: "small" | "medium";
};

export function IconButton({
  label,
  children,
  size = "medium",
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      className={`icon-button icon-button--${size} ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
