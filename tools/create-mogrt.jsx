(function () {
    var scriptFile = new File($.fileName);
    var root = scriptFile.parent.parent;
    var outputFolder = new Folder(root.fsName + "/extension/assets");
    var workFolder = new Folder(root.fsName + "/artifacts/mogrt");
    var resultFile = new File(workFolder.fsName + "/build-result.txt");
    var projectFile = new File(workFolder.fsName + "/LocalWhisper_Default_25_6.aep");
    var projectOnlyFlag = new File(workFolder.fsName + "/project-only.flag");
    var lines = [];

    function log(value) {
        lines.push(String(value));
    }

    function addSlider(layer, name, value, comp) {
        var effect = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
        effect.name = name;
        var property = effect.property(1);
        property.setValue(value);
        if (!property.canAddToMotionGraphicsTemplate(comp)) throw new Error(name + " cannot be added to Essential Graphics");
        if (!property.addToMotionGraphicsTemplateAs(comp, name)) throw new Error(name + " was rejected by Essential Graphics");
        return property;
    }

    try {
        app.beginSuppressDialogs();
        if (!outputFolder.exists && !outputFolder.create()) throw new Error("Cannot create extension/assets");
        if (!workFolder.exists && !workFolder.create()) throw new Error("Cannot create artifacts/mogrt");

        app.newProject();
        var comp = app.project.items.addComp("LocalWhisper_Default_25_6", 1920, 1080, 1, 5, 25);
        comp.motionGraphicsTemplateName = "LocalWhisper_Default_25_6";

        var controls = comp.layers.addNull();
        controls.name = "LWS Controls";
        controls.enabled = false;
        controls.shy = true;
        addSlider(controls, "LWS_FONT_SIZE", 72, comp);
        addSlider(controls, "LWS_TRACKING", 0, comp);
        addSlider(controls, "LWS_LEADING", 86, comp);
        addSlider(controls, "LWS_POSITION_X", 50, comp);
        addSlider(controls, "LWS_POSITION_Y", 88, comp);

        var textLayer = comp.layers.addText("本地字幕");
        textLayer.name = "LWS Subtitle";
        textLayer.inPoint = 0;
        textLayer.outPoint = comp.duration;
        var sourceText = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var documentValue = sourceText.value;
        documentValue.text = "本地字幕";
        documentValue.fontSize = 72;
        documentValue.tracking = 0;
        documentValue.autoLeading = false;
        documentValue.leading = 86;
        documentValue.applyFill = true;
        documentValue.fillColor = [1, 1, 1];
        documentValue.applyStroke = false;
        documentValue.justification = ParagraphJustification.CENTER_JUSTIFY;
        sourceText.setValue(documentValue);
        sourceText.expression = [
            'var s = text.sourceText.style;',
            's = s.setFontSize(thisComp.layer("LWS Controls").effect("LWS_FONT_SIZE")(1));',
            's = s.setTracking(thisComp.layer("LWS Controls").effect("LWS_TRACKING")(1));',
            's = s.setAutoLeading(false);',
            's = s.setLeading(thisComp.layer("LWS Controls").effect("LWS_LEADING")(1));',
            's;'
        ].join("\n");

        var position = textLayer.property("ADBE Transform Group").property("ADBE Position");
        position.expression = [
            'var x = thisComp.layer("LWS Controls").effect("LWS_POSITION_X")(1);',
            'var y = thisComp.layer("LWS Controls").effect("LWS_POSITION_Y")(1);',
            '[thisComp.width * x / 100, thisComp.height * y / 100];'
        ].join("\n");

        if (!sourceText.canAddToMotionGraphicsTemplate(comp)) throw new Error("Source Text cannot be added to Essential Graphics");
        if (!sourceText.addToMotionGraphicsTemplateAs(comp, "LWS_TEXT")) throw new Error("LWS_TEXT was rejected by Essential Graphics");

        comp.hideShyLayers = true;
        app.project.save(projectFile);
        log("controllersBeforeExport=" + comp.motionGraphicsTemplateControllerCount);
        log("sourceTextExpressionError=" + sourceText.expressionError);
        log("positionExpressionError=" + position.expressionError);
        log("projectSaved=" + projectFile.exists);
        log("outputFolder=" + outputFolder.fsName);
        if (projectOnlyFlag.exists) {
            log("status=projectOnly");
            log("hostVersion=" + app.version);
            log("project=" + projectFile.fsName);
            log("controllers=" + comp.motionGraphicsTemplateControllerCount);
        } else {
            var exported = comp.exportAsMotionGraphicsTemplate(true, outputFolder.fsName);
            if (!exported) throw new Error("exportAsMotionGraphicsTemplate returned false");

            var mogrtFile = new File(outputFolder.fsName + "/LocalWhisper_Default_25_6.mogrt");
            if (!mogrtFile.exists || mogrtFile.length < 1024) throw new Error("MOGRT output was not created");
            log("status=ok");
            log("hostVersion=" + app.version);
            log("output=" + mogrtFile.fsName);
            log("bytes=" + mogrtFile.length);
            log("controllers=" + comp.motionGraphicsTemplateControllerCount);
        }
    } catch (error) {
        log("status=error");
        log("message=" + error.toString());
        log("line=" + (error.line || ""));
    } finally {
        try { app.endSuppressDialogs(false); } catch (ignoreDialogs) {}
        resultFile.encoding = "UTF-8";
        if (resultFile.open("w")) {
            resultFile.write(lines.join("\n"));
            resultFile.close();
        }
        try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (ignoreClose) {}
        try { app.quit(); } catch (ignoreQuit) {}
    }
}());
