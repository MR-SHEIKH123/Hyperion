import{useState}from'react';import{render,screen}from'@testing-library/react';import{describe,expect,it,vi}from'vitest';import{ErrorBoundary}from'./ErrorBoundary';
function Broken({fail}:{fail:boolean}){if(fail)throw new Error('private render detail');return <p>Healthy section</p>}
function Harness(){const[fail,setFail]=useState(true);return <ErrorBoundary><Broken fail={fail}/><button onClick={()=>setFail(false)}>repair</button></ErrorBoundary>}
describe('tool error boundary',()=>{it('shows a calm isolated fallback without raw error details',()=>{vi.spyOn(console,'error').mockImplementation(()=>{});render(<Harness/>);expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong here');expect(screen.queryByText(/private render detail/)).not.toBeInTheDocument();});});
