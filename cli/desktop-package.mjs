import {buildDesktopPackage} from '../core/desktop-package.mjs';
try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')throw Error('node cli/desktop-package.mjs --output <新的绝对目录>');console.log(JSON.stringify(buildDesktopPackage(args[1])));}catch(e){console.error('DESKTOP_PACKAGE_FAILED',e.message);process.exitCode=1;}
