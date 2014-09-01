/*
    MediaCenterJS - A NodeJS based mediacenter solution

    Copyright (C) 2014 - Jan Smolders

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
/* Global Imports */
var dblite = require('dblite'),
    fs = require('graceful-fs'),
    path = require('path'),
    os = require('os'),
    file_utils = require('../../lib/utils/file-utils'),
    ajax_utils = require('../../lib/utils/ajax-utils'),
    app_cache_handler = require('../../lib/handlers/app-cache-handler'),
    configuration_handler = require('../../lib/handlers/configuration-handler'),
    LastfmAPI = require('lastfmapi'),
    mm = require('musicmetadata'),
    album_title_cleaner = require('../../lib/utils/title-cleaner'),
    socket = require('../../lib/utils/setup-socket'),
    io = socket.io,
    dbschema = require('../../lib/utils/database-schema'),
    Album = dbschema.Album,
    Artist = dbschema.Artist,
    Track = dbschema.Track,
    async = require('async');

var config = configuration_handler.initializeConfiguration();

/* Constants */

var SUPPORTED_FILETYPES = "m4a";
var start = new Date();
var nrScanned = 0;
var totalFiles = 0;
var noResult = {
    "result":"none"
};

// Init Database
var database = require('../../lib/utils/database-connection');
var db = database.db;


/* Public Methods */

/**
 * Fetches the Metadata for the specified Album from discogs.org.
 * @param albumTitle         The Title of the Album
 * @param callback           The Callback
 */

/* walk over a directory recursivly */
var dir = path.resolve(config.musicpath);
var walk = function(dir, done) {
    var results = [];
    fs.readdir(dir, function(err, list) {
        if (err)
            return done(err);
        var i = 0;
        (function next() {
            var file = list[i++];
            if (!file)
                return done(null, results);
            file = dir + '/' + file;
            fs.stat(file, function(err, stat) {
                if (stat && stat.isDirectory()) {
                    walk(file, function(err, res) {
                        results = results.concat(res);
                        next();
                    });
                } else {
                    var ext = file.split(".");
                    ext = ext[ext.length - 1];
                    if (ext === SUPPORTED_FILETYPES) {
                        results.push(file);
                        // doParse(file);
                    }
                    next();
                }
            });
        })();
    });
};

var setupParse = function(req, res, serveToFrontEnd, results) {
    if (results && results.length > 0) {
        var i = 0;
        async.each(results, function(file, callback) {
             doParse(req, res, file, serveToFrontEnd, function() {
                console.log("I: ", ++i, "L:", results.length);
                callback();
             });
        }, function (err) {
            console.log("DOOOOOONNNNNEEEEEE");
            Album.findAll()
            .success(function(albums) {
                // res.json(albums);
            });
        });
    }
    if (!results) {
        console.log('no results!');
        res.json(noResult);
    }
};


var doParse = function(req, res, file, serveToFrontEnd, callback) {
    var parser = new mm(fs.createReadStream(file));

    var result = null;
    parser.on('metadata', function(md) {
        result = md;
    });
    parser.on('done', function(err) {
        if (err){
            console.log("err", err);
        } else {
            var trackName = "Unknown Title"
            ,   trackNo = ""
            ,   albumName = "Unknown Album"
            ,   genre = "Unknown"
            ,   artistName = "Unknown Artist"
            ,   year = "";

            if (result) {
                trackName = (result.title)        ? result.title.replace(/\\/g, '') : '';
                trackNo   = (result.track.no)     ? result.track.no : '';
                albumName = (result.album)        ? result.album.replace(/\\/g, '') : '';
                artistName= (result.artist[0])    ? result.artist[0].replace(/\\/g, '') : '';
                year      = (result.year)         ? result.year : 0;

                if(result.genre !== undefined ){
                    var genrelist = result.genre;
                    if(genrelist.length > 0 && genrelist !== ""){
                        genre = genrelist[0];
                    }
                }
            }
            albumName = "PRE" + albumName;
            // Get cover from LastFM
            getAdditionalDataFromLastFM(albumName, artistName, function(cover) {
                if (cover === '' || cover === null) {
                    cover = '/music/css/img/nodata.jpg';
                }
                var albumData = {
                        'title' : albumName,
                        'posterURL' : cover,
                        'year'  : year
                    };
                var artistData = {
                    'name' : artistName
                }
                Artist.findOrCreate(artistData, artistData)
                .complete(function (err, artist) {
                    Album.findOrCreate({'title' : albumName,
                                'ArtistId' :  artist.id}, albumData)
                    .complete(function(err, album) {
                        album.setArtist(artist).complete(function(err) {
                            album.createTrack({
                                'title' : trackName,
                                'order' : trackNo,
                                'filePath' : file
                            })
                            .complete(function(err) {
                                callback();
                            });
                        });
                    });
                });
            });
        }
    });
};



// storeAlbumInDatabase = function(req, res, serveToFrontEnd, metadata, callback){
//     db.query('INSERT OR REPLACE INTO albums VALUES(?,?,?,?,?)', metadata);

//     nrScanned++;

//     var perc = parseInt((nrScanned / totalFiles) * 100);
//     var increment = new Date(), difference = increment - start;
//     if (perc > 0) {
//         var total = (difference / perc) * 100, eta = total - difference;
//         io.sockets.emit('progress',{msg:perc});
//         console.log(perc+'% done');
//     }

//     if(nrScanned === totalFiles){
//         if(serveToFrontEnd === true){
//             io.sockets.emit('serverStatus',{msg:'Processing data...'});
//             getCompleteCollection(req, res);
//         }
//     }

// }

getAdditionalDataFromLastFM = function(album, artist, callback) {
    // Currently only the cover is fetched. Could be expanded in the future
    // Due to the proper caching backend provided by LastFM there is no need to locally store the covers.
    //var apiUrl = "http://www.mediacenterjs.com/global/js/musickey.js";
    var lastfm = new LastfmAPI({
        'api_key'   : "36de4274f335c37e12395286ec6e92c4",
        'secret'    : "1f74849490f1872c71d91530e82428e9"
    });

    var cover = '/music/css/img/nodata.jpg';

    lastfm.album.getInfo({
        'artist'    : artist,
        'album'     : album
    }, function(err, album){
        if(err){
            callback(cover);
        }

        if(album !== undefined && album.image[0] !== undefined && album.image[0] !== null){
            cover = album.image[3]["#text"];

            if(cover !== ''){
                callback(cover);
            } else {
                callback(cover);
            }
        }

    });
}

getCompleteCollection = function(req, res){
    db.query('SELECT * FROM albums ORDER BY album asc', {
        album   : String,
        artist  : String,
        year    : Number,
        genre   : String,
        cover   : String
    },
    function(err, rows) {
        if(err){
            console.log('DB error', err);
        } else if (rows !== undefined && rows !== null ){
            var count   = rows.length;
            var albums  = [];
            console.log('Found ' + count + ' albums, continuing...');
            rows.forEach(function (item, value) {
                console.log('Loading data for',item.album);

                if (item !== null && item !== undefined) {
                    var album   = item.album
                    , artist    = item.artist
                    , year      = item.year
                    , genre     = item.genre
                    , cover     = item.cover;

                    getTracks(album, artist, year, genre, cover, function (completeAlbum){
                        if(completeAlbum !== null){
                            count--;
                            albums.push(completeAlbum);
                            if (count === 0) {
                                console.log('Sending info to client');
                                return res.json(albums);
                                res.end();
                               // db.close();
                            }
                        } else {
                            console.log('Error retrieving tracks...');
                            res.json(noResult);
                        }
                    });
                }
            });
        }
    });
}

getTracks = function (album, artist, year, genre, cover, callback){
    console.log('looking for tracks');
    db.query('SELECT * FROM tracks WHERE album = $album ORDER BY track asc ', { album: album }, {
        title       : String,
        track       : Number,
        album       : String,
        artist      : String,
        year        : Number,
        genre       : String,
        filename    : String
    },
    function (err, rows) {
        if(err){
            callback(null);
        }
        if (typeof rows !== 'undefined' && rows !== null) {
            var completeAlbum = {
                "album"     : album,
                "artist"    : artist,
                "year"      : year,
                "genre"     : genre,
                "cover"     : cover,
                "tracks"    : rows
            }
            callback(completeAlbum);
        }
    });
}



exports.loadData = function(req, res, serveToFrontEnd) {
    nrScanned = 0;
    walk(dir,  function(err, results) {
        totalFiles = (results) ? results.length : 0;
        setupParse(req, res, serveToFrontEnd, results);
    });
}
