import type{ButtonHTMLAttributes}from'react';import styles from'./Button.module.css';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>{variant?:'default'|'primary'|'quiet';}
export function Button({variant='default',className='',type='button',...props}:ButtonProps){return <button type={type} className={`${styles.button} ${variant==='primary'?styles.primary:variant==='quiet'?styles.quiet:''} ${className}`} {...props}/>;}
