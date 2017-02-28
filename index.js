'use strict'

var https = require('https');
var fs = require('fs');
var zlib = require('zlib');
var tar = require('tar-fs');

/**
 * promise wrapper around https get function
 */
function httpsGetAsync(options) {
    return new Promise((resolve, reject) => {
        https.get(options, response => {
            if(response.statusCode !== 200) {
                reject(new Error(`GET ${options.hostname}${options.path} returned ${response.statusCode}`));
            } else {
                resolve(response);
            }
        });
    });

}

/**
 * similar to Bluebird's Promise.each given a list of parameters and a function that returns a promise
 * this function will synchronize the exectution of the promise function across the array of parameters
 * 
 * if the maxConcurrent parameter is supplied it will run that many promises in parallel
 * 
 * @param parameters, an array of arguments to supply to the promise function
 * @param func, a function which return a promise
 * @param maxConcurrent, how many promises to run in parallel
 * @return a promise of all the results in a single flat array
 */
function promiseEach(parameters, func, maxConcurrent) {
    if(!maxConcurrent) maxConcurrent = 1;  // if not supplied default to 1

    // bite off maxConcurrent number of aruguments off the head of the array (splice mutates the undlying array)
    let params = parameters.splice(0, maxConcurrent);
    
    // apply the arguments to the promise returning function and wait for them to complete with Promise.all
    return Promise.all(params.map(param => {
        if(Array.isArray(param))
            return func.apply(null, param);

        return func(param)
    }))
    .then(results => {
        // i want to return one flat array of results, hence flattening...
        let flatResults = [].concat.apply([], results);

        // base case, we've consumed the entire array of promises, just return the flattened array of 
        // results
        if(parameters.length === 0) {
            return flatResults;
        }

        // soooo here is the trick, remember up above where i mentioned that splice mutates the array?
        // after we process a bite off the array of arguments, check if the entire array has been consumed
        // if not recursively call this function with the remaining arguments array
        //
        // note this isn't really recurision because this is a promise returning function, the function returns
        // right away, so it shouldn't blow up the stack.
        return promiseEach(parameters, func, maxConcurrent)
            .then(function(otherResults) {
                return flatResults.concat(otherResults);
            });
    });
}

/**
 * scrapes a page of most depended on node packages.  I tried to optimize over
 * other DOM parsing libraries, however I did not do timings...
 */
function scrapeMostDepended(offset) {

    let options = {
        hostname: 'www.npmjs.com',
        path: `/browse/depended?offset=${offset}`,
        // Optimization #1
        // in my experience network transport is actually the slowest, so request a compressed page
        headers: { 'accept-encoding': 'gzip,deflate' } 
    };

    // Optimization #2
    // Usually a regular express is not the recommend way to scrape because they are not as
    // robust as a DOM parser.  however that only applies to very generic scrapers.  In this case
    // we have a very specific target with well formed HTML.  So I think a regular expression is 
    // actually faster in this case, because we don't need to build/traverse the DOM.  The regular
    // expression just goes top down looking for anchor tags with the version class
    let re = /[^<]*(<a class="version" href="\/package\/([^"]+)">([^<]+)<\/a>)/g;

    return httpsGetAsync(options)
    .then(response => {
        let buffer;
        let unzip = zlib.createGunzip();
        let mostDepended = [];

        return new Promise((resolve, reject) => {
            response.pipe(unzip);

            unzip.on('data', chunk => buffer += chunk);
            unzip.on('error', err => reject(err));
            unzip.on('end', () => {
                let body = buffer.toString('utf-8');
                let matches;
                while((matches = re.exec(body))) {
                    // in the above regular expression, the name and version of the package
                    // are captured in index 2, 3
                    mostDepended.push(matches.slice(2, 4));
                }

                resolve(mostDepended);
            });
        });
    });
}

/**
 * download a compressed tarball from the npm registry and extract it
 */
function downloadAndExtractPackage(pkg, version) {
    let org = '';
    let name = pkg;
    // node package name can have '/' and @ (like @angular/commons)
    // we need to encode these before writing to the filesystem
    let folderName = encodeURIComponent(pkg);

    // usually the path for packages in the registry is {name}/-/{name}-{version}, but for 
    // packages that start with an '@' it's {org}{name}/-/{name}-{version}
    //
    // the org mentioned about is the substring from '@' to a '/'.
    // everything after the '/' is the package name
    if(pkg.startsWith('@')) {
        let index = pkg.indexOf('/') + 1;
        org = pkg.slice(0, index);
        name = pkg.slice(index);
    }

    return httpsGetAsync(`https://registry.npmjs.org/${org}${name}/-/${name}-${version}.tgz`)
    .then(response => {
        return new Promise((resolve, reject) => {
            let unzip = zlib.createGunzip();
            unzip.on('error', err => reject(err));

            // here is another oddity.
            // so the assignment just asks to extract the tarball in the '/packages directory
            // the test check for specific modules by doing a 'require()'
            //
            // however, when the tarballs extract the module is in a folder named 'package', so 
            // on disk the the module lodash will look as follows ./packages/lodash/package.  This will
            // fail to load with require.
            // 
            // to accomodate for this rename contents in the tarball on the fly
            let untar = tar.extract(`./packages`, {
                map: header => {
                    header.name = header.name.replace(/^package/, folderName);
                    return header;
                }
            });
            untar.on('error', err => reject(err));
            untar.on('finish', () =>resolve(pkg));

            response.pipe(unzip).pipe(untar);            
        });

    });
}

function downloadPackages (count, callback) {
    let offsets = [];
    for(let i = 0; i < count; i += 36) {
        offsets.push(i);
    }

    promiseEach(offsets, scrapeMostDepended, 3)
        .then(mostDepended => {
            let toBeDownloaded = mostDepended.splice(0, count);
            return promiseEach(toBeDownloaded, downloadAndExtractPackage, 3);
        })
        .then(() => callback())
        .catch(err =>  callback(err));
}

module.exports = downloadPackages